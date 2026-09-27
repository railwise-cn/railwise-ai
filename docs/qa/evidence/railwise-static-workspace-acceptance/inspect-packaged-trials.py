#!/usr/bin/env python3
"""Read-only exact-rational oracle for known synthetic static-append fixtures.
No product imports; raw SHA/SQL binding and arithmetic only, not JS hash replay,
source authenticity, GUI automation, or professional approval.
"""
import argparse,json,math,sqlite3
from pathlib import Path
from fractions import Fraction as F
from hashlib import sha256

def equal(a,b):
    if isinstance(b,list):
        assert isinstance(a,list) and len(a)==len(b)
        for x,y in zip(a,b):equal(x,y)
    else:assert isinstance(a,(int,float)) and math.isfinite(a) and math.isclose(a,float(b),rel_tol=2e-10,abs_tol=2e-10),(a,str(b))

def fit(rows,p):
    a=[[F(v) for v in r['coefficients']] for r in rows];w=[1/F(r['aprioriVariance']) for r in rows];y=[F(r['value']) for r in rows]
    n=[[sum((w[k]*a[k][i]*a[k][j] for k in range(len(rows))),F(0)) for j in range(p)] for i in range(p)]
    aug=[n[i]+[F(i==j) for j in range(p)] for i in range(p)]
    for i in range(p):
        k=next(j for j in range(i,p) if aug[j][i]);aug[i],aug[k]=aug[k],aug[i]
        d=aug[i][i];aug[i]=[x/d for x in aug[i]]
        for j in range(p):
            if i!=j:
                d=aug[j][i];aug[j]=[x-d*z for x,z in zip(aug[j],aug[i])]
    cov=[r[p:] for r in aug];rhs=[sum((w[k]*a[k][i]*y[k] for k in range(len(rows))),F(0)) for i in range(p)]
    x=[sum((cov[i][j]*rhs[j] for j in range(p)),F(0)) for i in range(p)]
    adjusted=[sum((c*v for c,v in zip(r,x)),F(0)) for r in a];res=[v-z for v,z in zip(y,adjusted)];sse=sum((q*r*r for q,r in zip(w,res)),F(0));df=len(rows)-p
    return {'parameters':x,'aprioriParameterCovariance':cov,'adjustedObservations':adjusted,'residuals':res,'weightedResidualSumSquares':sse,'degreesOfFreedom':df,'posteriorVarianceFactorEstimate':sse/df}

def check_fit(actual,rows,p):
    expected=fit(rows,p)
    for k,v in expected.items():equal(actual[k],v)
    assert actual['posteriorEstimateUse']=='diagnostic-only-not-applied-to-prior-covariance-or-weights'
    return expected

def check(row,fixtures):
    r=json.loads(row['data_json']);request=bytes(row['request_bytes']);decl=bytes(row['declaration_bytes']);q=json.loads(request)
    assert request.decode()==r['requestJson'] and decl.decode()==r['declarationJson']==q['declarationJson']
    assert sha256(request).hexdigest()==r['requestSha256']==row['request_hash'] and sha256(decl).hexdigest()==r['declarationSha256']
    assert len(request)==r['requestSizeBytes'] and len(decl)==r['declarationSizeBytes']
    assert sha256(r['modelBasisStatement'].encode()).hexdigest()==r['modelBasisSha256']
    for k,c in [('id','id'),('projectId','project_id'),('projectRevision','project_revision'),('projectBindingHash','project_binding_hash'),('kind','kind'),('idempotencyKey','idempotency_key'),('recordHash','record_hash'),('createdAt','created_at')]:assert r[k]==row[c]
    assert r['kind']==q['kind']=='static-incremental' and r['acknowledged']==q['acknowledged']==True
    assert not r['formalResultsModified'] and r['modelAssumptions']=='not-verified' and r['engineeringDecision']=='not-evaluated'
    d=json.loads(decl);name=next((k for k,v in fixtures.items() if v==d),None);assert name,'Unknown declaration'
    z=r['result'];assert not z['formalResultsModified'] and not z['originalObservationsModified'] and not z['priorRuntimeStateVerified']
    prefixes=0
    if name=='stale-base-declaration':
        assert z['outcome']=='unavailable' and z['code']=='base-fingerprint-mismatch'
        assert 'updatedFit' not in z and 'baseFit' not in z
    else:
        assert z['outcome']=='calculated';base=d['base']['observations'];added=d['append']['observations'];p=len(d['base']['parameterIds'])
        check_fit(z['baseFit'],base,p);check_fit(z['updatedFit'],base+added,p);check_fit(z['batchCheck']['referenceFit'],base+added,p)
        assert z['observationIds']==[x['id'] for x in base+added] and len(z['steps'])==len(added)
        for i,step in enumerate(z['steps']):
            assert step['observationId']==added[i]['id'] and step['totalObservationCount']==len(base)+i+1
            equal(step['accumulatedResidualNorm']**2,fit(base+added[:i+1],p)['weightedResidualSumSquares']);prefixes+=1
    return {'id':r['id'],'fixture':name,'outcome':z['outcome'],'rawBindings':'passed','independentFits':'passed' if prefixes else 'not-applicable-unavailable','prefixSseChecks':prefixes}

def main():
    a=argparse.ArgumentParser();a.add_argument('database',type=Path);a.add_argument('--project',required=True);args=a.parse_args()
    source=Path(__file__).resolve().parent.parent/'railwise-static-workspace'
    fixtures={n:json.loads((source/(n+'.json')).read_text()) for n in ['sample-declaration','stale-base-declaration','maximum-declaration']}
    with sqlite3.connect(args.database.resolve().as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        records=[check(r,fixtures) for r in db.execute("SELECT * FROM advanced_trials WHERE project_id=? AND kind='static-incremental' ORDER BY created_at,id",(args.project,))]
    assert {r['fixture'] for r in records}==set(fixtures),'All three static fixtures required'
    print(json.dumps({'status':'passed','projectId':args.project,'count':len(records),'records':records,'scope':'Independent rational fits and prefix SSE plus raw byte/SQL bindings; not GUI, JS canonical replay or professional approval'},indent=2))
if __name__=='__main__':main()
