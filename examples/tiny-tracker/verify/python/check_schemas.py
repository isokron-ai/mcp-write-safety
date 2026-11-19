"""Checks tiny-tracker's JSON Schemas (schemas/*.schema.json).

Needs the `jsonschema` package (4.18 or later, with `referencing`); it is a
check for maintainers and harness authors, not a runtime dependency.

  python3 -I check_schemas.py                       every schema is a valid 2020-12 schema with a unique $id;
                                                    every example in schemas/examples validates; so do the vectors
  python3 -I check_schemas.py --instance NAME       validates the JSON on stdin against schemas/NAME-1.schema.json
"""

import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
BASE = "https://writesafety.dev/schemas/tiny-tracker/"

try:
    import jsonschema
    from referencing import Registry, Resource
except ImportError:  # pragma: no cover
    sys.stderr.write("needs the jsonschema package (pip install jsonschema)\n")
    sys.exit(3)


def load_schemas():
    schemas = {}
    for path in sorted(glob.glob(os.path.join(ROOT, "schemas", "*.schema.json"))):
        with open(path, encoding="utf-8") as f:
            schemas[os.path.basename(path)] = json.load(f)
    return schemas


def registry(schemas):
    return Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas.values())


def validator(schemas, name):
    schema = schemas["%s-1.schema.json" % name]
    return jsonschema.Draft202012Validator(schema, registry=registry(schemas), format_checker=jsonschema.FormatChecker())


def check_all():
    schemas = load_schemas()
    problems = []
    ids = set()
    for file, schema in schemas.items():
        jsonschema.Draft202012Validator.check_schema(schema)
        sid = schema.get("$id", "")
        if sid != BASE + file:
            problems.append("%s: $id is %r, expected %r" % (file, sid, BASE + file))
        if sid in ids:
            problems.append("%s: duplicate $id" % file)
        ids.add(sid)
    examples = sorted(glob.glob(os.path.join(ROOT, "schemas", "examples", "*.json")))
    for path in examples:
        name = os.path.basename(path)[:-5]
        with open(path, encoding="utf-8") as f:
            instance = json.load(f)
        for err in validator(schemas, name).iter_errors(instance):
            problems.append("example %s: %s at %s" % (name, err.message, list(err.absolute_path)))
    with open(os.path.join(ROOT, "vectors", "digest-1.json"), encoding="utf-8") as f:
        vectors = json.load(f)
    for err in validator(schemas, "digest-vectors").iter_errors(vectors):
        problems.append("vectors: %s at %s" % (err.message, list(err.absolute_path)))
    return len(schemas), len(examples), problems


def main(argv):
    if len(argv) == 3 and argv[1] == "--instance":
        schemas = load_schemas()
        errors = ["%s at %s" % (e.message, list(e.absolute_path)) for e in validator(schemas, argv[2]).iter_errors(json.load(sys.stdin))]
        sys.stdout.write(json.dumps(errors) + "\n")
        return 1 if errors else 0
    count, examples, problems = check_all()
    for p in problems:
        sys.stdout.write(p + "\n")
    sys.stdout.write("%d schemas, %d examples, %d problems\n" % (count, examples, len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
