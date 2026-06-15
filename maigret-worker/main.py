import asyncio
import logging

from flask import Flask, request as flask_request, jsonify

app = Flask(__name__)
logger = logging.getLogger("maigret-worker")
logging.basicConfig(level=logging.INFO)


def run_maigret(username: str) -> dict:
    from maigret import search as maigret_search
    from maigret.sites import MaigretDatabase
    import maigret.resources

    # Load from package resources
    resources_path = maigret.resources.__path__[0] if hasattr(maigret.resources, '__path__') else None
    db = MaigretDatabase()
    if resources_path:
        import os
        data_file = os.path.join(resources_path, "data.json")
        if os.path.exists(data_file):
            db.load_from_path(data_file)
        else:
            db.load_from_resources()
    else:
        db.load_from_resources()

    sites = db.ranked_sites_dict(tags=["social"])

    results = asyncio.run(
        maigret_search(
            username=username,
            site_dict=sites,
            logger=logger,
            timeout=30,
            is_parsing_enabled=True,
            no_progressbar=True,
        )
    )

    socials = {}
    for site_name, result in results.items():
        if result["status"].is_found():
            if site_name.lower() in ("twitter", "x"):
                continue
            socials[site_name.lower()] = result["url_user"]

    return socials


@app.route("/search", methods=["POST"])
def search():
    body = flask_request.get_json(force=True)
    user_id = body.get("user_id")
    username = body.get("username")

    if not user_id or not username:
        return jsonify({"error": "Missing user_id or username"}), 400

    logger.info(f"Running maigret for @{username} (user_id={user_id})")

    try:
        socials = run_maigret(username)
        status = "done"
        logger.info(f"Found {len(socials)} platforms for @{username}: {list(socials.keys())}")
    except Exception as e:
        import traceback
        logger.error(f"Maigret failed for @{username}: {e}\n{traceback.format_exc()}")
        socials = {}
        status = "failed"

    error_msg = ""
    if status == "failed":
        error_msg = str(e) if 'e' in dir() else "unknown"
    return jsonify({"ok": True, "socials": socials, "status": status, "error": error_msg})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
