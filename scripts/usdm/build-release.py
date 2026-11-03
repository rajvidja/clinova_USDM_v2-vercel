"""Build a ProtocolIQ USDM release package from the official CDISC deliverables.

Inputs (downloaded unmodified):
  USDM_API.json, dataStructure.yml   https://github.com/cdisc-org/DDF-RA/tree/v<release>/Deliverables
  DDF Terminology.txt                 https://evs.nci.nih.gov/ftp1/CDISC/DDF/
  SDTM Terminology.txt                https://evs.nci.nih.gov/ftp1/CDISC/SDTM/
  Protocol Terminology.txt            https://evs.nci.nih.gov/ftp1/CDISC/Protocol/

Usage:
  python3 scripts/usdm/build-release.py <input dir> <release> <ddf ct date> <sdtm ct date> <protocol ct date>

Writes server/usdm/releases/<release>/{USDM_API.json, model.json, terminology.json, release.json}.
Only codelists referenced by the release's model (plus the DDF package) are kept.
"""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]

# SDTM / Protocol codelists that the USDM CT workbook points to for attributes ProtocolIQ can populate.
SDTM_CODELISTS = ["C66737", "C99076", "C66735", "C66729", "C71113", "C66797", "C99077", "C99078", "C99079", "C66732", "C71620", "C66736"]
PROTOCOL_CODELISTS = ["C174222"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_ct(path: Path, wanted: list[str] | None, package: str, version: str) -> dict:
    rows = list(csv.reader(path.open(encoding="utf-8"), delimiter="\t"))[1:]
    lists: dict[str, dict] = {}
    for r in rows:
        code, cl, ext, name, value, synonyms, definition, preferred = (r + [""] * 8)[:8]
        if not cl and (code in wanted if wanted is not None else "Value Set" in name):
            lists[code] = {"code": code, "name": name, "extensible": ext == "Yes", "package": package, "packageVersion": version, "terms": []}
    for r in rows:
        code, cl, _ext, _name, value, synonyms, definition, preferred = (r + [""] * 8)[:8]
        if cl in lists:
            lists[cl]["terms"].append(
                {
                    "code": code,
                    "submissionValue": value,
                    "synonyms": [s.strip() for s in synonyms.split(";") if s.strip()],
                    "preferredTerm": preferred,
                    "definition": definition,
                }
            )
    return lists


def model(structure: dict) -> dict:
    classes = {}
    for name, spec in structure.items():
        attrs = {}
        for attr, a in (spec.get("Attributes") or {}).items():
            attrs[attr] = {
                "types": [t["$ref"].lstrip("#/") for t in a.get("Type", [])],
                "cardinality": a.get("Cardinality"),
                "relationship": a.get("Relationship Type"),
                "representation": a.get("Model Representation"),
                "cCode": a.get("NCI C-Code"),
                "preferredTerm": a.get("Preferred Term"),
                "definition": a.get("Definition"),
                "inheritedFrom": (a.get("Inherited From") or {}).get("$ref", "").lstrip("#/") or None
                if isinstance(a.get("Inherited From"), dict)
                else a.get("Inherited From"),
            }
        classes[name] = {
            "cCode": spec.get("NCI C-Code"),
            "preferredTerm": spec.get("Preferred Term"),
            "definition": spec.get("Definition"),
            "abstract": spec.get("Modifier") == "Abstract",
            "superClasses": [s["$ref"].lstrip("#/") for s in spec.get("Super Classes", [])],
            "attributes": attrs,
        }
    return classes


def main() -> int:
    src = Path(sys.argv[1])
    release, ddf_v, sdtm_v, prot_v = sys.argv[2:6]
    out = ROOT / "server" / "usdm" / "releases" / release
    out.mkdir(parents=True, exist_ok=True)

    shutil.copyfile(src / "USDM_API.json", out / "USDM_API.json")
    api = json.loads((out / "USDM_API.json").read_text())
    if api["info"]["version"] != release:
        raise SystemExit(f"USDM_API.json is version {api['info']['version']}, expected {release}")

    classes = model(yaml.safe_load((src / "dataStructure.yml").read_text()))
    (out / "model.json").write_text(json.dumps({"release": release, "classes": classes}, indent=1, ensure_ascii=False))

    codelists = {}
    codelists.update(read_ct(src / "ddf_ct.txt", None, "DDF", ddf_v))
    codelists.update(read_ct(src / "sdtm_ct.txt", SDTM_CODELISTS, "SDTM", sdtm_v))
    codelists.update(read_ct(src / "protocol_ct.txt", PROTOCOL_CODELISTS, "Protocol", prot_v))
    missing = [c for c in SDTM_CODELISTS + PROTOCOL_CODELISTS if c not in codelists]
    if missing:
        raise SystemExit(f"Codelists not found: {missing}")
    (out / "terminology.json").write_text(json.dumps({"codeSystem": "http://www.cdisc.org", "codelists": codelists}, indent=1, ensure_ascii=False))

    meta = {
        "version": release,
        "name": f"CDISC USDM {release}",
        "description": f"CDISC Unified Study Definitions Model {release} (DDF-RA v{release}). API schema: OpenAPI {api.get('openapi')} '{api['info']['title']}'.",
        "schemaFile": "USDM_API.json",
        "rootSchema": "Wrapper-Input",
        "sources": [
            {"name": "USDM_API.json", "url": f"https://github.com/cdisc-org/DDF-RA/blob/v{release}/Deliverables/API/USDM_API.json", "sha256": sha256(out / "USDM_API.json"), "license": "MIT (CDISC DDF-RA)"},
            {"name": "dataStructure.yml", "url": f"https://github.com/cdisc-org/DDF-RA/blob/v{release}/Deliverables/UML/dataStructure.yml", "sha256": sha256(src / "dataStructure.yml"), "license": "MIT (CDISC DDF-RA)"},
            {"name": "DDF Terminology", "url": "https://evs.nci.nih.gov/ftp1/CDISC/DDF/", "version": ddf_v},
            {"name": "SDTM Terminology", "url": "https://evs.nci.nih.gov/ftp1/CDISC/SDTM/", "version": sdtm_v},
            {"name": "Protocol Terminology", "url": "https://evs.nci.nih.gov/ftp1/CDISC/Protocol/", "version": prot_v},
        ],
        "coreRules": "CDISC CORE conformance rules for USDM are not bundled or executed by ProtocolIQ.",
    }
    (out / "release.json").write_text(json.dumps(meta, indent=2))
    print(f"Wrote {out} ({len(classes)} classes, {len(codelists)} codelists)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
