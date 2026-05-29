import { jsonResponse } from "../../lib/http.js";
import { RECOMPUTE_INSERT_SQL, SNAPSHOT_TABLE } from "../transactions/recompute-sql.js";

export async function handleRecompute(request, env, url) {
  console.log("[recompute] triggered via /api/recompute");
  const result = await recomputeBankMid(env);
  if (result.error) {
    return jsonResponse(result, { status: 500 });
  }
  return jsonResponse(result);
}

async function recomputeBankMid(env) {
  console.log(`[recompute] snapshotting current bank_mid → ${SNAPSHOT_TABLE}`);
  try {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${SNAPSHOT_TABLE}`).run();
    await env.DB.prepare(
      `CREATE TABLE ${SNAPSHOT_TABLE} AS SELECT * FROM bank_mid`
    ).run();
  } catch (err) {
    console.error(`[recompute] snapshot failed — bank_mid untouched`, err.message);
    return { error: "snapshot failed", detail: err.message };
  }

  const snap = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM ${SNAPSHOT_TABLE}`
  ).first();
  console.log(`[recompute] snapshot has ${snap.c} rows`);

  console.log("[recompute] wiping and rebuilding bank_mid (atomic batch)");
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM bank_mid"),
      env.DB.prepare(RECOMPUTE_INSERT_SQL),
    ]);
  } catch (err) {
    console.error(
      `[recompute] failed — bank_mid is unchanged (atomic rollback)`,
      err.message
    );
    return {
      error: "recompute failed",
      detail: err.message,
      restoreSql: `INSERT INTO bank_mid SELECT * FROM ${SNAPSHOT_TABLE}`,
    };
  }

  const after = await env.DB.prepare(
    `SELECT COUNT(*) AS c, SUM(success_count) AS s, SUM(fail_count) AS f FROM bank_mid`
  ).first();
  console.log(
    `[recompute] done — rows=${after.c} Σsuccess=${after.s ?? 0} Σfail=${after.f ?? 0}`
  );

  return {
    result: "SUCCESS",
    snapshotRows: snap.c,
    newRows: after.c,
    totalSuccess: after.s ?? 0,
    totalFail: after.f ?? 0,
  };
}
