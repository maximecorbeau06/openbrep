from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from openbrep import tapir_controller


class TapirSessionState(dict):
    """Dict/attribute state adapter for existing Tapir controller functions."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value


# Dossier de la bibliothèque intégrée Archicad qui reçoit les objets envoyés par l'app.
EMBEDDED_LIBRARY_FOLDER = "MM STUDIO GDL"


def _library_file_name(name: str) -> str:
    """Nom de fichier sûr pour la bibliothèque (pas de séparateurs ni caractères réservés)."""
    cleaned = "".join("_" if ch in '/\\:*?"<>|' else ch for ch in str(name or "").strip())
    return cleaned.strip(". ") or "Objet MM STUDIO"


def default_tapir_bridge_loader() -> tuple[Callable[[], object] | None, bool]:
    try:
        from openbrep.tapir_bridge import get_bridge

        return get_bridge, True
    except Exception:
        return None, False


@dataclass
class WorkbenchTapirAdapter:
    tapir_import_ok: bool
    get_bridge_fn: Callable[[], object] | None
    now_text_fn: Callable[[], str]
    state: TapirSessionState = field(default_factory=TapirSessionState)

    def __post_init__(self) -> None:
        self.state.setdefault("tapir_selected_guids", [])
        self.state.setdefault("tapir_selected_details", [])
        self.state.setdefault("tapir_selected_params", [])
        self.state.setdefault("tapir_param_edits", {})
        self.state.setdefault("tapir_last_error", "")
        self.state.setdefault("tapir_last_sync_at", "")

    def status_response(self) -> dict[str, Any]:
        return {"ok": True, "tapir": self.snapshot()}

    def snapshot(self) -> dict[str, Any]:
        bridge_status = self._bridge_status()
        available = bool(self.tapir_import_ok and bridge_status.get("tapir_available"))
        message = self._status_message(bridge_status, available)
        return {
            "import_ok": self.tapir_import_ok,
            "available": available,
            "archicad_connected": bool(bridge_status.get("archicad_connected")),
            "tapir_available": bool(bridge_status.get("tapir_available")),
            "version": str(bridge_status.get("version") or ""),
            "message": message,
            "selected_guids": list(self.state.get("tapir_selected_guids") or []),
            "selected_details": list(self.state.get("tapir_selected_details") or []),
            "selected_params": list(self.state.get("tapir_selected_params") or []),
            "param_edits": dict(self.state.get("tapir_param_edits") or {}),
            "last_error": str(self.state.get("tapir_last_error") or ""),
            "last_sync_at": str(self.state.get("tapir_last_sync_at") or ""),
        }

    def reload_libraries(self) -> dict[str, Any]:
        if not self.tapir_import_ok or self.get_bridge_fn is None:
            return self._action(False, "Tapir bridge 未导入")
        bridge = self.get_bridge_fn()
        if not bridge.is_available():
            self.state.tapir_last_error = "Archicad 未运行或 Tapir 未安装"
            return self._action(False, self.state.tapir_last_error)
        ok = bool(bridge.reload_libraries())
        msg = "已通知 Archicad 重载图库" if ok else "Tapir 重载 Archicad 图库失败"
        self.state.tapir_last_error = "" if ok else msg
        return self._action(ok, msg)

    def archicad_targets(self) -> list[dict[str, Any]]:
        """Projets Archicad ouverts pouvant recevoir un objet (vide si Tapir indisponible)."""
        if not self.tapir_import_ok or self.get_bridge_fn is None:
            return []
        bridge = self.get_bridge_fn()
        lister = getattr(bridge, "list_open_projects", None)
        return list(lister()) if callable(lister) else []

    def send_library_part(self, gsm_path: str, object_name: str, *, port: int | None = None,
                          project_name: str = "") -> dict[str, Any]:
        """Dépose le .gsm compilé dans la bibliothèque intégrée d'Archicad puis recharge.

        Avec ``port`` : tout passe par une connexion dédiée à ce port (send_to_port) —
        jamais par la connexion partagée, qui peut revenir au premier Archicad trouvé
        (incident du 11/11/2026 : objet parti dans un projet client au lieu du projet choisi).
        """
        if not self.tapir_import_ok or self.get_bridge_fn is None:
            return self._action(False, "Le module Tapir n'est pas disponible dans l'app.")
        if port is None:
            return self._action(False, "Aucun projet Archicad choisi.")
        bridge = self.get_bridge_fn()
        target = f"{EMBEDDED_LIBRARY_FOLDER}/{_library_file_name(object_name)}.gsm"
        ok, error, reloaded = bridge.send_to_port(int(port), gsm_path, target)
        if not ok:
            self.state.tapir_last_error = f"Envoi refusé par Archicad : {error}"
            return self._action(False, self.state.tapir_last_error)
        self.state.tapir_last_error = ""
        where = f"« {project_name} »" if project_name else "Archicad"
        message = (
            f"Objet envoyé dans {where} (bibliothèque intégrée › {target})."
            if reloaded
            else f"Objet déposé dans {where} ({target}), mais le rechargement des bibliothèques a échoué : "
            "utilise Fichier › Bibliothèques et objets › Recharger."
        )
        return {**self._action(True, message), "library_path": target, "reloaded": reloaded}

    def sync_selection(self) -> dict[str, Any]:
        ok, message = tapir_controller.tapir_sync_selection(
            tapir_import_ok=self.tapir_import_ok,
            get_bridge_fn=self._require_bridge,
            session_state=self.state,
            now_text_fn=self.now_text_fn,
        )
        return self._action(ok, message)

    def highlight_selection(self) -> dict[str, Any]:
        ok, message = tapir_controller.tapir_highlight_selection(
            tapir_import_ok=self.tapir_import_ok,
            get_bridge_fn=self._require_bridge,
            session_state=self.state,
        )
        return self._action(ok, message)

    def load_selected_params(self) -> dict[str, Any]:
        ok, message = tapir_controller.tapir_load_selected_params(
            tapir_import_ok=self.tapir_import_ok,
            get_bridge_fn=self._require_bridge,
            session_state=self.state,
        )
        return self._action(ok, message)

    def apply_param_edits(self, edits: dict[str, Any] | None = None) -> dict[str, Any]:
        if edits is not None:
            self.state.tapir_param_edits = dict(edits)
        ok, message = tapir_controller.tapir_apply_param_edits(
            tapir_import_ok=self.tapir_import_ok,
            get_bridge_fn=self._require_bridge,
            session_state=self.state,
        )
        return self._action(ok, message)

    def evaluate_library_part(
        self,
        lib_part_name: str = "",
        lib_part_guid: str = "",
        parameters: dict[str, Any] | None = None,
        want: list[str] | None = None,
    ) -> dict[str, Any]:
        """P15：调用 OpenBrep Add-On 的 EvaluateLibraryPart（Archicad 权威
        求值）。连接/命令不可用时返回 {ok: False, error} 结构化结果。"""
        if not self.tapir_import_ok or self.get_bridge_fn is None:
            return {"ok": False, "error": "Tapir bridge 未导入"}
        try:
            bridge = self._require_bridge()
            status = bridge.get_status() if hasattr(bridge, "get_status") else {}
            if isinstance(status, dict) and not status.get("archicad_connected"):
                return {"ok": False, "error": "Archicad 未连接"}
            fn = getattr(bridge, "evaluate_library_part", None)
            if fn is None:
                return {"ok": False, "error": "当前 Tapir bridge 不支持权威求值"}
            raw = fn(lib_part_name=lib_part_name, lib_part_guid=lib_part_guid,
                     parameters=parameters, want=want)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        if not isinstance(raw, dict):
            return {"ok": False, "error": f"权威求值返回格式异常: {type(raw).__name__}"}
        if raw.get("success") is not True:
            return {"ok": False, "error": str(raw.get("errorMessage") or "权威求值失败")}
        return {"ok": True, **raw}

    def verify_library_part_artifact(self, **request: Any) -> dict[str, Any]:
        """Verify that Archicad evaluated the exact GSM artifact in ``request``."""
        if not self.tapir_import_ok or self.get_bridge_fn is None:
            return {
                "ok": False,
                "code": "unsupported",
                "error": "Tapir bridge 未导入",
            }
        try:
            bridge = self._require_bridge()
            status = bridge.get_status() if hasattr(bridge, "get_status") else {}
            if isinstance(status, dict) and not status.get("archicad_connected"):
                return {
                    "ok": False,
                    "code": "disconnected",
                    "error": "Archicad 未连接",
                }
            verify = getattr(bridge, "verify_library_part_artifact", None)
            if not callable(verify):
                return {
                    "ok": False,
                    "code": "unsupported",
                    "error": "当前 OpenBrep Add-On 不支持产物身份验收",
                }
            raw = verify(**request)
        except Exception as exc:
            error = str(exc)
            return {
                "ok": False,
                "code": "unsupported" if _is_unsupported_command(error) else "host_error",
                "error": error,
            }
        if not isinstance(raw, dict):
            return {
                "ok": False,
                "code": "host_error",
                "error": f"产物身份验收返回格式异常: {type(raw).__name__}",
            }
        if raw.get("success") is not True:
            error = str(raw.get("errorMessage") or "产物身份验收失败")
            return {
                "ok": False,
                "code": "unsupported" if _is_unsupported_command(error) else "host_error",
                "error": error,
            }
        return {"ok": True, **raw}

    def _action(self, ok: bool, message: str) -> dict[str, Any]:
        return {"ok": ok, "message": message, "tapir": self.snapshot()}

    def _require_bridge(self) -> object:
        if self.get_bridge_fn is None:
            raise RuntimeError("Tapir bridge 未导入")
        return self.get_bridge_fn()

    def _bridge_status(self) -> dict[str, Any]:
        if not self.tapir_import_ok or self.get_bridge_fn is None:
            return {"archicad_connected": False, "tapir_available": False, "version": ""}
        try:
            bridge = self.get_bridge_fn()
            status = bridge.get_status() if hasattr(bridge, "get_status") else {}
            if isinstance(status, dict):
                if status.get("connection_error"):
                    self.state.tapir_last_error = str(status["connection_error"])
                elif status.get("archicad_connected"):
                    self.state.tapir_last_error = ""
                return status
        except Exception as exc:
            self.state.tapir_last_error = str(exc)
        return {"archicad_connected": False, "tapir_available": False, "version": ""}

    def _status_message(self, bridge_status: dict[str, Any], available: bool) -> str:
        if not self.tapir_import_ok:
            return "Tapir bridge 未导入"
        if available:
            return "Archicad + Tapir 已连接"
        if bridge_status.get("archicad_connected"):
            return "Archicad 已连接，但 Tapir 不可用"
        return "Archicad 未运行或 Tapir 未安装"


def _is_unsupported_command(error: str) -> bool:
    lowered = error.lower()
    return any(
        marker in lowered
        for marker in (
            "unknown command",
            "unsupported",
            "not supported",
            "does not support",
            "additional properties",
            "additionalproperties",
            "unexpected property",
        )
    )
