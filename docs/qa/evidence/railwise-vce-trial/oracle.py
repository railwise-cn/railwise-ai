"""Independent condition-space/SVD oracle; does not import production code."""
import json
from fractions import Fraction as F
from pathlib import Path
import numpy as np

def run(a, y, groups, initial, q=None, limit=100, tolerance=1e-10):
    a, y = np.array(a, float), np.array(y, float)
    q = np.ones(len(y)) if q is None else np.array(q, float)
    u, singular, _ = np.linalg.svd(a, full_matrices=True)
    b = u[:, a.shape[1]:]
    t = b.T @ y
    projected = [b.T @ np.diag(q * (np.array(groups) == g)) @ b for g in range(len(initial))]
    theta = np.array(initial, float)
    trace = []
    for _ in range(limit):
        qt = sum(v * mat for v, mat in zip(theta, projected))
        wt = np.linalg.inv(qt)
        n = np.array([[np.trace(wt @ x @ wt @ z)/2 for z in projected] for x in projected])
        rhs = np.array([t @ wt @ x @ wt @ t / 2 for x in projected])
        if np.linalg.matrix_rank(n) < len(theta):
            return {'status': 'unidentifiable', 'trace': trace}
        nxt = np.linalg.solve(n, rhs)
        change = float(np.max(np.abs(nxt - theta) / np.maximum(np.abs(nxt), np.abs(theta))))
        trace.append({'current': theta.tolist(), 'candidate': nxt.tolist(), 'relativeChange': change})
        if np.any(nxt <= 0):
            return {'status': 'nonpositive-component', 'trace': trace}
        theta = nxt
        if change <= tolerance:
            w = np.diag(1/sum(v*np.diag(q*(np.array(groups)==g)) for g,v in enumerate(theta)).diagonal())
            x = np.linalg.solve(a.T @ w @ a, a.T @ w @ y)
            return {'status': 'converged', 'components': theta.tolist(), 'parameters': x.tolist(), 'residuals': (y-a@x).tolist(), 'trace':trace}
    return {'status':'iteration-limit', 'trace':trace}

def main():
    y1,y2,s1,s2=map(F,['1.6','0.9','-0.9','3.6'])
    exact=[(3*(y1*y1+y2*y2)+2*(s1*s2-2*y1*y2)-(s1+s2)*(y1+y2))/6,
           (3*(s1*s1+s2*s2)+2*(y1*y2-2*s1*s2)-(s1+s2)*(y1+y2))/6]
    fixtures=[
      {'id':'paper-negative','a':[[1]]*4,'y':[1.6,.9,-.9,3.6],'groups':[0,0,1,1],'initial':[1,1]},
      {'id':'paper-positive','a':[[1]]*4,'y':[1.6,.9,-.9,3.6],'groups':[0,0,1,1],'initial':[1,10]},
      {'id':'one-group','a':[[1]]*4,'y':[1,2,4,5],'groups':[0]*4,'initial':[7]},
      {'id':'two-repeated-vectors','a':[[1,0],[0,1],[1,0],[0,1]],'y':[1,2,3,5],'groups':[0,0,1,1],'initial':[1,1]},
      {'id':'three-positive-groups','a':[[1,0],[0,1]]*6,'y':[0,1,2,3,-1,0,3,4,-2,-1,4,5],'groups':[0]*4+[1]*4+[2]*4,'initial':[1,2,3],'q':[1,2,1,2]*3},
      {'id':'three-groups-relative-q','a':[[1,0],[0,1]]*3,'y':[1,2,2.5,4,4,3],'groups':[0,0,1,1,2,2],'initial':[1,2,3],'q':[1,2,1,2,1,2]},
    ]
    result={'sourceSha256':'4c4b6311f6da13844f559c48a57a62cd5467434b51d563805ae176a7a4ec9207','numpyVersion':np.__version__, 'exactEquation4126':list(map(str,exact)), 'fixtures':[]}
    for f in fixtures:
        result['fixtures'].append({**f,'expected':run(**{k:v for k,v in f.items() if k!='id'})})
    Path(__file__).with_name('oracle.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__': main()
