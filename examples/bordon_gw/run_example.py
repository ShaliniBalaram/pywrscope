# examples/bordon_gw/run_example.py
# Demonstrates calling the PyWR Canvas Flask API against the Bordon GW example model.
# Prerequisites: python python/server.py must be running in a separate terminal.

import json
import urllib.request
import os

API = "http://127.0.0.1:47821/api"
MODEL_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "bordon_gw.json"))


def call(route, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API}{route}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def main():
    print("=== Bordon GW Example ===\n")

    # 1. Parse the model
    print("1. Parsing model...")
    result = call("/parse", {"json_path": MODEL_PATH})
    assert result["ok"], result.get("error")
    nodes = result["data"]["nodes"]
    edges = result["data"]["edges"]
    print(f"   Loaded {len(nodes)} nodes, {len(edges)} edges")
    for n in nodes:
        print(f"   - {n['name']} ({n['type']})")

    # 2. Validate
    print("\n2. Validating model...")
    with open(MODEL_PATH) as f:
        model = json.load(f)
    result = call("/validate", {"model": model})
    assert result["ok"], result.get("error")
    print(f"   Errors:   {len(result['data']['errors'])}")
    print(f"   Warnings: {len(result['data']['warnings'])}")
    for w in result["data"]["warnings"]:
        print(f"   ⚠ [{w['code']}] {w['message']}")

    # 3. Add recorders
    print("\n3. Adding recorders...")
    result = call("/add-recorders", {"model": model})
    assert result["ok"], result.get("error")
    added = result["data"]["added"]
    print(f"   Added {len(added)} recorder(s):")
    for a in added:
        print(f"   + {a['recorder_type']} → {a['node']}")

    # 4. Export
    output_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "bordon_gw_with_recorders.json")
    )
    print(f"\n4. Exporting to {output_path} ...")
    result = call("/export", {"model": result["data"]["model"], "output_path": output_path})
    assert result["ok"], result.get("error")
    print(f"   Written to: {result['data']['written_to']}")
    print("\nDone.")


if __name__ == "__main__":
    main()
