import json
import traceback
from flask import Flask, request, jsonify
from pyiceberg.catalog.rest import RestCatalog

app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/compact", methods=["POST"])
def compact():
    body = request.get_json(force=True)
    catalog_uri = body["catalog_uri"]
    warehouse = body["warehouse"]
    namespace = body["namespace"]
    table_name = body["table"]
    token = body["token"]
    # Business key a row is deduped on. Rows missing any key column fall back to `id`
    # (pre-fix rows written before channel_id/source_user_id existed on the schema).
    key_columns = body.get("key_columns", ["tenant_id", "channel_id", "source_user_id"])
    order_column = body.get("order_column", "updated_at")

    try:
        catalog = RestCatalog(name="uniscrm", uri=catalog_uri, warehouse=warehouse, token=token)
        table = catalog.load_table(f"{namespace}.{table_name}")

        arrow_table = table.scan().to_arrow()
        rows_before = arrow_table.num_rows
        if rows_before == 0:
            return jsonify({"rows_before": 0, "rows_after": 0, "removed": 0})

        df = arrow_table.to_pandas()

        dedup_key = df[key_columns[0]].astype(str)
        for col in key_columns[1:]:
            dedup_key = dedup_key + "\x1f" + df[col].astype(str)
        has_full_key = df[key_columns].notna().all(axis=1)
        df["_dedup_key"] = dedup_key.where(has_full_key, df["id"].astype(str))

        df = df.sort_values(order_column, ascending=False)
        deduped = df.drop_duplicates(subset="_dedup_key", keep="first").drop(columns=["_dedup_key"])

        rows_after = len(deduped)
        if rows_after < rows_before:
            import pyarrow as pa
            deduped_arrow = pa.Table.from_pandas(deduped, schema=arrow_table.schema, preserve_index=False)
            table.overwrite(deduped_arrow)

        return jsonify({"rows_before": rows_before, "rows_after": rows_after, "removed": rows_before - rows_after})
    except Exception as err:
        traceback.print_exc()
        return jsonify({"error": str(err)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
