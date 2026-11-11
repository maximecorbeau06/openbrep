from __future__ import annotations

from types import SimpleNamespace

import openbrep.tapir_bridge as tapir_bridge_module
from openbrep.tapir_bridge import TapirBridge


def test_addon_command_parameters_are_passed_as_raw_mapping():
    calls = []

    class FakeCommands:
        def ExecuteAddOnCommand(self, command_id, parameters):
            calls.append((command_id, parameters))
            return {"success": True}

    bridge = TapirBridge()
    bridge._conn = SimpleNamespace(
        types=SimpleNamespace(
            AddOnCommandId=lambda namespace, name: (namespace, name),
        ),
        commands=FakeCommands(),
    )

    result = bridge._tapir_call(
        "EvaluateLibraryPart",
        {"libPartName": "Chair", "parameters": {"A": 1.25}},
        addon_id="OpenBrep",
    )

    assert result == {"success": True}
    assert calls == [
        (
            ("OpenBrep", "EvaluateLibraryPart"),
            {"libPartName": "Chair", "parameters": {"A": 1.25}},
        )
    ]


def test_evaluate_library_part_forwards_requested_outputs():
    calls = []

    class FakeCommands:
        def ExecuteAddOnCommand(self, command_id, parameters):
            calls.append(parameters)
            return {"success": True}

    bridge = TapirBridge()
    bridge._conn = SimpleNamespace(
        types=SimpleNamespace(AddOnCommandId=lambda namespace, name: (namespace, name)),
        commands=FakeCommands(),
    )

    bridge.evaluate_library_part(
        lib_part_name="Stair",
        parameters={"A": 4.6},
        want=["mesh3d", "prims2d"],
    )

    assert calls == [{
        "libPartName": "Stair",
        "parameters": {"A": 4.6},
        "want": ["mesh3d", "prims2d"],
    }]


def test_verify_library_part_artifact_forwards_hash_and_path():
    calls = []

    class FakeCommands:
        def ExecuteAddOnCommand(self, command_id, parameters):
            calls.append((command_id, parameters))
            return {"success": True, "identityStatus": "verified"}

    bridge = TapirBridge()
    bridge._conn = SimpleNamespace(
        types=SimpleNamespace(AddOnCommandId=lambda namespace, name: (namespace, name)),
        commands=FakeCommands(),
    )

    result = bridge.verify_library_part_artifact(
        gsm_path="/tmp/stair.gsm",
        gsm_sha256="abc",
        lib_part_name="Stair",
        lib_part_guid="guid",
        parameters={"A": 2.0},
        want=["identity", "mesh3d"],
        scenario_id="default",
        spec_hash="sha256:spec",
        dependencies_hash="sha256:deps",
    )

    assert result["success"] is True
    assert calls == [(
        ("OpenBrep", "VerifyLibraryPartArtifact"),
        {
            "gsmPath": "/tmp/stair.gsm",
            "gsmSha256": "abc",
            "libPartName": "Stair",
            "libPartGuid": "guid",
            "parameters": {"A": 2.0},
            "want": ["identity", "mesh3d"],
            "restoreLibraryState": True,
            "rollbackElements": True,
            "protocolVersion": 1,
            "scenarioId": "default",
            "specHash": "sha256:spec",
            "dependenciesHash": "sha256:deps",
        },
    )]


def test_connect_scans_archicad_ports_instead_of_consuming_workbench_port(monkeypatch):
    calls = []
    connection = object()

    class FakeConnectionApi:
        @staticmethod
        def find_first_port():
            calls.append(("scan",))
            return 19723

        @staticmethod
        def connect(port):
            calls.append(("connect", port))
            return connection

    monkeypatch.setattr(tapir_bridge_module, "_AC_AVAILABLE", True)
    monkeypatch.setattr(tapir_bridge_module, "ACConnection", FakeConnectionApi)

    bridge = TapirBridge()

    assert bridge.connect() is True
    assert bridge._conn is connection
    assert calls == [("scan",), ("connect", 19723)]


def test_send_to_port_uses_a_dedicated_connection_to_the_chosen_port(monkeypatch):
    """Régression 11/11/2026 : la connexion partagée pointait sur le projet client
    (19723) ; l'envoi doit partir UNIQUEMENT vers le port choisi (19725)."""
    import openbrep.tapir_bridge as tb
    calls = []

    class FakeConn:
        def __init__(self, port):
            self.port = port
            self.types = SimpleNamespace(AddOnCommandId=lambda namespace, name: (namespace, name))
            self.commands = SimpleNamespace(ExecuteAddOnCommand=self._run)

        def _run(self, command_id, params):
            calls.append((self.port, command_id[1], params))
            return {"executionResults": [{"success": True}]} if command_id[1] == "AddFilesToEmbeddedLibrary" else {}

    monkeypatch.setattr(tb, "_AC_AVAILABLE", True)
    monkeypatch.setattr(tb, "ACConnection", SimpleNamespace(connect=lambda port: FakeConn(port)))
    bridge = tb.TapirBridge()
    bridge._conn = FakeConn(19723)  # connexion partagée sur le projet client

    ok, error, reloaded = bridge.send_to_port(19725, "/tmp/Table.gsm", "MM STUDIO GDL/Table.gsm")

    assert (ok, error, reloaded) == (True, "", True)
    assert [(port, name) for port, name, _ in calls] == [(19725, "AddFilesToEmbeddedLibrary"), (19725, "ReloadLibraries")]
    assert calls[0][2] == {"files": [{"inputPath": "/tmp/Table.gsm", "outputPath": "MM STUDIO GDL/Table.gsm", "type": "Object"}]}


def test_send_to_port_reports_archicad_refusal(monkeypatch):
    import openbrep.tapir_bridge as tb

    class FakeConn:
        types = SimpleNamespace(AddOnCommandId=lambda namespace, name: (namespace, name))
        commands = SimpleNamespace(ExecuteAddOnCommand=lambda command_id, params: {
            "executionResults": [{"success": False, "error": {"message": "file exists"}}]})

    monkeypatch.setattr(tb, "_AC_AVAILABLE", True)
    monkeypatch.setattr(tb, "ACConnection", SimpleNamespace(connect=lambda port: FakeConn()))
    assert tb.TapirBridge().send_to_port(19725, "/tmp/a.gsm", "MM STUDIO GDL/a.gsm") == (False, "file exists", False)


def test_list_open_projects_reads_project_names_per_port(monkeypatch):
    import openbrep.tapir_bridge as tb

    class FakeConn:
        def __init__(self, port):
            self.types = SimpleNamespace(AddOnCommandId=lambda namespace, name: (namespace, name))
            info = {19723: {"projectName": "AURELIA", "isUntitled": False}, 19725: {"isUntitled": True}}[port]
            self.commands = SimpleNamespace(ExecuteAddOnCommand=lambda command_id, params: info)

    class FakeACConnection:
        @staticmethod
        def connect(port):
            return FakeConn(port) if port in (19723, 19725) else None

    monkeypatch.setattr(tb, "_AC_AVAILABLE", True)
    monkeypatch.setattr(tb, "ACConnection", FakeACConnection)

    assert tb.TapirBridge().list_open_projects() == [
        {"port": 19723, "project_name": "AURELIA", "untitled": False},
        {"port": 19725, "project_name": "Projet sans titre", "untitled": True},
    ]
