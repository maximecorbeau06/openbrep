from __future__ import annotations

from typing import Any, Callable


class WorkbenchTapirService:
    """Routes /api/tapir/* : état, bibliothèques, sélection, paramètres, envoi vers Archicad."""

    def __init__(
        self,
        adapter: Any,
        *,
        compile_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        project_name_fn: Callable[[], str] | None = None,
    ) -> None:
        self.adapter = adapter
        self.compile_fn = compile_fn
        self.project_name_fn = project_name_fn or (lambda: "")

    def route(self, method: str, route: str, body: dict[str, Any] | None) -> dict[str, Any]:
        body = body or {}
        if method == "GET" and route == "/api/tapir/status":
            return self.status_response()
        if method == "POST" and route == "/api/tapir/send-to-archicad":
            return self.send_to_archicad(body)
        if method == "POST" and route == "/api/tapir/reload-libraries":
            return self.reload_libraries()
        if method == "POST" and route == "/api/tapir/selection/sync":
            return self.sync_selection()
        if method == "POST" and route == "/api/tapir/selection/highlight":
            return self.highlight_selection()
        if method == "POST" and route == "/api/tapir/parameters/load":
            return self.load_selected_params()
        if method == "POST" and route == "/api/tapir/parameters/apply":
            return self.apply_param_edits(body)
        return {"ok": False, "error": f"Unknown route: {method} {route}"}

    def status_response(self) -> dict[str, Any]:
        return self.adapter.status_response()

    def send_to_archicad(self, body: dict[str, Any]) -> dict[str, Any]:
        """Compile avec le vrai convertisseur puis dépose le .gsm dans l'Archicad ouvert."""
        if self.compile_fn is None:
            return {"ok": False, "message": "Compilation indisponible.", "tapir": self.adapter.snapshot()}
        targets = self.adapter.archicad_targets()
        port = body.get("port")
        if port is None:
            if not targets:
                return {"ok": False, "message": "Aucun projet Archicad ouvert avec Tapir : ouvre Archicad puis réessaie.",
                        "tapir": self.adapter.snapshot()}
            if len(targets) > 1:
                # Plusieurs projets ouverts : ne jamais deviner (risque d'envoyer dans un projet client).
                return {"ok": False, "needs_target": True, "targets": targets,
                        "message": "Plusieurs projets Archicad sont ouverts : choisis celui qui doit recevoir l'objet.",
                        "tapir": self.adapter.snapshot()}
            port = targets[0]["port"]
        try:
            port = int(port)
        except (TypeError, ValueError):
            return {"ok": False, "message": "Projet Archicad invalide.", "tapir": self.adapter.snapshot()}
        project_name = next((t.get("project_name", "") for t in targets if t.get("port") == port), "")
        compiled = self.compile_fn({**body, "compiler_mode": "lp"})
        details = compiled.get("compile") or {}
        gsm_path = details.get("output_path")
        if not compiled.get("ok") or not gsm_path or details.get("mode") == "mock":
            reason = compiled.get("error") or "le convertisseur d'Archicad n'a pas produit de fichier .gsm"
            return {"ok": False, "message": f"Compilation impossible : {reason}", "compile": details,
                    "tapir": self.adapter.snapshot()}
        sent = self.adapter.send_library_part(str(gsm_path), self.project_name_fn(), port=port,
                                              project_name=project_name)
        return {**sent, "compile": details}

    def reload_libraries(self) -> dict[str, Any]:
        return self.adapter.reload_libraries()

    def sync_selection(self) -> dict[str, Any]:
        return self.adapter.sync_selection()

    def highlight_selection(self) -> dict[str, Any]:
        return self.adapter.highlight_selection()

    def load_selected_params(self) -> dict[str, Any]:
        return self.adapter.load_selected_params()

    def apply_param_edits(self, body: dict[str, Any]) -> dict[str, Any]:
        edits = body.get("param_edits")
        return self.adapter.apply_param_edits(edits if isinstance(edits, dict) else None)
