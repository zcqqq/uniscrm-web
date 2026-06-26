import asyncio
import logging
import os

from flask import Flask, request, jsonify

app = Flask(__name__)
logger = logging.getLogger("maigret")
logging.basicConfig(level=logging.INFO)

_sites = None


def get_sites():
    global _sites
    if _sites is None:
        import maigret
        from maigret.sites import MaigretDatabase

        data_path = os.path.join(os.path.dirname(maigret.__file__), "resources", "data.json")
        db = MaigretDatabase()
        db.load_from_file(data_path)
        _sites = db.ranked_sites_dict(tags=["social"])
        logger.info(f"Loaded {len(_sites)} sites from {data_path}")
    return _sites


@app.route("/search", methods=["POST"])
def search():
    from maigret import search as maigret_search

    username = request.get_json().get("username")
    if not username:
        return jsonify({"error": "username required"}), 400

    logger.info(f"Searching for @{username}")

    try:
        sites = get_sites()
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
        socials = {
            name.lower(): r["url_user"]
            for name, r in results.items()
            if r["status"].is_found() and name.lower() not in ("twitter", "x")
        }
        logger.info(f"Found {len(socials)} platforms for @{username}")
        return jsonify({"socials": socials, "status": "done"})
    except Exception as e:
        logger.error(f"Failed for @{username}: {e}")
        return jsonify({"socials": {}, "status": "failed", "error": str(e)})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
