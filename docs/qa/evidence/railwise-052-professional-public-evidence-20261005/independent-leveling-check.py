#!/usr/bin/env python3
"""AI-authored, synthetic exact-rational review; no field/vendor certification.

The independent solver uses a Fraction KKT system. It does not import any
RailWise arithmetic. Current TypeScript is transpiled into a temporary folder
only, and the product result is compared with that separate reference.
"""
import hashlib
import json
import subprocess
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DEST = Path(__file__).resolve().parent / "independent-leveling-result.json"
IDS = ["A", "B", "C", "D"]
HEIGHTS = [F(0), F(1), F(2), F(3)]
EDGES = [(0, 1), (1, 2), (2, 3), (3, 0), (0, 2), (1, 3)]
READINGS = list(map(F, ["1.001", "0.998", "1.004", "-2.999", "2.001", "2.003"]))
WEIGHTS = list(map(F, [1, 4, 9, 16, 25, 36]))


def inverse(matrix):
    n = len(matrix)
    work = [row[:] + [F(i == j) for j in range(n)] for i, row in enumerate(matrix)]
    for j in range(n):
        pivot = next(i for i in range(j, n) if work[i][j])
        work[j], work[pivot] = work[pivot], work[j]
        d = work[j][j]
        work[j] = [v / d for v in work[j]]
        for i in range(n):
            if i != j:
                d = work[i][j]
                work[i] = [a - d * b for a, b in zip(work[i], work[j])]
    return [row[n:] for row in work]


def reference():
    design = [[F((j == to) - (j == frm)) for j in range(4)] for frm, to in EDGES]
    misclosures = [l - HEIGHTS[to] + HEIGHTS[frm] for l, (frm, to) in zip(READINGS, EDGES)]
    normal = [[sum(w * row[i] * row[j] for w, row in zip(WEIGHTS, design)) for j in range(4)] for i in range(4)]
    kkt = [row + [F(1)] for row in normal] + [[F(1)] * 4 + [F(0)]]
    inv = inverse(kkt)
    rhs = [sum(w * row[i] * l for w, row, l in zip(WEIGHTS, design, misclosures)) for i in range(4)] + [F(0)]
    x = [sum(v * b for v, b in zip(row, rhs)) for row in inv][:4]
    heights = [h + dx for h, dx in zip(HEIGHTS, x)]
    adjusted = [heights[to] - heights[frm] for frm, to in EDGES]
    residual = [l - a for l, a in zip(READINGS, adjusted)]
    qh = [row[:4] for row in inv[:4]]
    qa = [[sum(a * qh[i][j] * b for i, a in enumerate(left) for j, b in enumerate(right)) for right in design] for left in design]
    qv = [[(1 / WEIGHTS[i] if i == j else F(0)) - qa[i][j] for j in range(6)] for i in range(6)]
    sse = sum(w * v * v for w, v in zip(WEIGHTS, residual))
    assert sum(x) == 0
    assert all(sum(w * row[i] * v for w, row, v in zip(WEIGHTS, design, residual)) == 0 for i in range(4))
    assert sum(qv[i][i] * WEIGHTS[i] for i in range(6)) == 3
    return {"corrections": x, "heights": heights, "adjusted": adjusted, "residuals": residual,
            "heightCofactor": qh, "residualCofactor": qv, "weightedSSE": sse, "posteriorVarianceFactorEstimate": sse / 3}


ref = reference()
request = {
    "model": "independent-linear-height-differences", "unit": "m", "constraint": "sum-height-corrections-zero",
    "points": [{"id": p, "referenceHeight": float(h)} for p, h in zip(IDS, HEIGHTS)],
    "observations": [{"id": f"L{i+1}", "from": IDS[frm], "to": IDS[to], "heightDifference": float(l), "weight": float(w),
                      "weightSource": "independent-review-declared", "sourceAnchor": f"synthetic-exact-kkt:{i+1}"}
                     for i, ((frm, to), l, w) in enumerate(zip(EDGES, READINGS, WEIGHTS))],
    "aprioriVarianceFactor": 1e-6,
}
node_source = r"""
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const ts=(await import(pathToFileURL(path.join(process.cwd(),'node_modules/typescript/lib/typescript.js')).href)).default;
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const input=JSON.parse(raw),tmp=await fs.mkdtemp(path.join(os.tmpdir(),'railwise-independent-kkt-'));
try{
 await fs.writeFile(path.join(tmp,'package.json'),'{"type":"module"}');
 for(const name of ['survey-adjustment-core','survey-free-leveling']){
  const src=await fs.readFile(path.join(process.cwd(),'kun/src/engineering',name+'.ts'),'utf8');
  const compiled=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  await fs.writeFile(path.join(tmp,name+'.js'),compiled);
 }
 const {solveFreeLevelingTrial:solve}=await import(pathToFileURL(path.join(tmp,'survey-free-leveling.js')).href);
 const result={base:solve(input)};
 const mm=structuredClone(input);mm.unit='mm';mm.points.forEach(p=>p.referenceHeight*=1000);mm.observations.forEach(o=>{o.heightDifference*=1000;o.weight/=1e6});
 result.mm=solve(mm);
 const perm=structuredClone(input);perm.points.reverse();perm.observations.reverse();result.permuted=solve(perm);
 for(const [name,obs] of [['noRedundancy',input.observations.slice(0,3)],['disconnected',input.observations.filter(o=>!['C','D'].includes(o.from)&&!['C','D'].includes(o.to))]]){
  try{solve({...input,observations:obs});result[name]={unexpectedSuccess:true};}catch(e){result[name]={reason:e.reason};}
 }
 process.stdout.write(JSON.stringify(result));
}finally{await fs.rm(tmp,{recursive:true,force:true});}
"""
run = subprocess.run(["node", "--input-type=module", "-e", node_source], cwd=ROOT,
                     input=json.dumps(request), text=True, capture_output=True, check=True)
actual = json.loads(run.stdout)


def flat(value):
    if isinstance(value, list):
        return [z for v in value for z in flat(v)]
    return [float(value)]


base = actual["base"]
errors = {}
for field, got in {
    "corrections": [p["correction"] for p in base["points"]], "heights": [p["height"] for p in base["points"]],
    "adjusted": [o["adjustedHeightDifference"] for o in base["observations"]], "residuals": [o["residual"] for o in base["observations"]],
    "heightCofactor": base["heightCofactor"], "residualCofactor": base["residualCofactor"],
    "weightedSSE": base["weightedSSE"], "posteriorVarianceFactorEstimate": base["posteriorVarianceFactorEstimate"],
}.items():
    errors[field] = max(abs(a-b) for a,b in zip(flat(got),flat(ref[field])))
assert max(errors.values()) < 1e-12, errors
assert base["rank"] == 3 and base["datumDefect"] == 1 and base["degreesOfFreedom"] == 3
assert base["status"] == "trial-only" and base["engineeringDecision"] == "not-evaluated"
mm = actual["mm"]
mm_error = max(abs(p["height"]/1000 - q["height"]) for p,q in zip(mm["points"],base["points"]))
mm_cov_error = max(abs(a/1e6-b) for a,b in zip(flat(mm["heightCofactor"]),flat(base["heightCofactor"])))
assert mm_error < 1e-12 and mm_cov_error < 1e-12
by_id = {p["id"]:p["height"] for p in base["points"]}
perm_error = max(abs(p["height"]-by_id[p["id"]]) for p in actual["permuted"]["points"])
assert perm_error < 1e-12
assert actual["noRedundancy"]["reason"] == "insufficient-redundancy"
assert actual["disconnected"]["reason"] == "disconnected-network"


def rationals(value):
    if isinstance(value, dict):
        return {k:rationals(v) for k,v in value.items()}
    if isinstance(value, list):
        return [rationals(v) for v in value]
    return str(value)


report = {
    "scope":"AI-authored synthetic analytical benchmark; not field, vendor, standards or professional-signoff evidence",
    "referenceMethod":"exact Fraction KKT elimination with sum-height-corrections-zero; independent of product arithmetic",
    "sourceHashes":{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in [
        "kun/src/engineering/survey-free-leveling.ts","kun/src/engineering/survey-adjustment-core.ts"]},
    "declaredUnit":"m", "declaredWeightUnit":"inverse squared input length", "declaredKnownVarianceFactor":1e-6,
    "request":request, "referenceRationals":rationals(ref), "actual":actual,
    "maximumAbsoluteErrors":errors, "metreMillimetreHeightErrorMetres":mm_error,
    "metreMillimetreCofactorErrorInMetresSquared":mm_cov_error,"permutationHeightErrorMetres":perm_error,
    "rank":3,"datumDefect":1,"degreesOfFreedom":3,
    "exactChecks":["sum corrections = 0","B transpose P residual = 0","sum redundancy = 3"],
    "negativeChecks":{"noRedundancy":"insufficient-redundancy","disconnected":"disconnected-network"},
    "result":"passed bounded 1D free-leveling kernel; general free/quasi-stable production scope remains open"
}
DEST.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"result":report["result"],"maximumAbsoluteErrors":errors,"unitErrorMetres":mm_error,"permutationErrorMetres":perm_error,"output":str(DEST)},indent=2))
