"""Checks openapi.yaml as an OpenAPI 3.1 document.

Needs the `openapi-spec-validator` package (0.7 or later) and PyYAML; it is a
check for maintainers, not a runtime dependency. The record schemas are
referred to by their $id; this check maps every $id (in openapi.yaml and
inside the schemas) to a temporary copy of the local schemas/ folder, so
nothing is fetched from the network.

  python3 -I check_openapi.py       exit 0 when valid, 1 when not, 3 when the packages are missing
"""

import json
import os
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent

try:
    import yaml
    from openapi_spec_validator import validate
except ImportError:  # pragma: no cover
    sys.stderr.write("needs openapi-spec-validator and PyYAML (pip install openapi-spec-validator)\n")
    sys.exit(3)


def main() -> int:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="tt-openapi-"))
    try:
        ids = {}
        for f in sorted((ROOT / "schemas").glob("*.schema.json")):
            sid = json.loads(f.read_text(encoding="utf-8")).get("$id")
            if sid:
                ids[sid] = (tmp / f.name).as_uri()

        def rewrite(text: str) -> str:
            for sid, uri in ids.items():
                text = text.replace(sid, uri)
            return text

        for f in (ROOT / "schemas").glob("*.schema.json"):
            (tmp / f.name).write_text(rewrite(f.read_text(encoding="utf-8")), encoding="utf-8")
        raw = (ROOT / "openapi.yaml").read_text(encoding="utf-8")
        refs = sorted({line.split('$ref: "')[1].split('"')[0] for line in raw.splitlines()
                       if "writesafety.dev" in line and "$ref" in line})
        missing = [r for r in refs if r not in ids]
        if missing:
            print(f"openapi.yaml refers to schema $ids that schemas/ does not hold: {', '.join(missing)}")
            return 1
        spec = yaml.safe_load(rewrite(raw))
        try:
            validate(spec, base_uri=(ROOT / "openapi.yaml").as_uri())
        except Exception as e:  # the validator's own error types differ between versions
            print(f"openapi.yaml is not valid: {e}")
            return 1
        print(f"openapi.yaml: valid OpenAPI {spec['openapi']}; {len(spec['paths'])} paths; "
              f"{len(refs)} schema $ids resolved from schemas/")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
