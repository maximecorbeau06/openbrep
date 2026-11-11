"""Garde-fou d'emballage : sans le paquet ``archicad`` dans l'app installée, tout le
pont Tapir est inactif (« Archicad Python API 未安装 ») — bouton « Envoyer vers
Archicad », sélection, rechargement des bibliothèques."""
from pathlib import Path


def test_archicad_api_is_a_runtime_dependency_and_bundled():
    pyproject = Path("pyproject.toml").read_text(encoding="utf-8")
    spec = Path("openbrep-backend.spec").read_text(encoding="utf-8")
    assert '"archicad>=' in pyproject
    assert 'collect_submodules("archicad")' in spec
    # versioning.discover() parcourt archicad/releases/ sur le disque
    assert 'collect_data_files("archicad", include_py_files=True)' in spec
