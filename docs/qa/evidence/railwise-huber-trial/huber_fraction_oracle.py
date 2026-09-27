"""Exact independent piecewise Huber oracle: enumerate inlier/tail partitions.
No IRLS iteration, floating linear algebra, or implementation code is used.
Boundary points may occur in several partitions. A full-rank inlier Hessian
is only a sufficient way to find candidates, not a proof that no other
minimizer exists. Equal distinct candidates prove nonuniqueness.
"""
from fractions import Fraction as F
from itertools import product
import json
from pathlib import Path

def solve(a,b):
    n=len(b);r=[list(row)+[value] for row,value in zip(a,b)]
    for j in range(n):
        pivot=next((i for i in range(j,n) if r[i][j]),None)
        if pivot is None:return None
        r[j],r[pivot]=r[pivot],r[j];v=r[j][j];r[j]=[x/v for x in r[j]]
        for i in range(n):
            if i==j:continue
            v=r[i][j];r[i]=[x-v*y for x,y in zip(r[i],r[j])]
    return [r[i][-1] for i in range(n)]

def exact(model):
    a=[[F(str(v)) for v in row] for row in model['A']];y=[F(str(v)) for v in model['y']]
    scale=F(str(model.get('scale',1)));sigma=[scale*F(str(v)) for v in model.get('sigma',[1]*len(y))];k=F(str(model.get('k',1)));p=len(a[0]);candidates={}
    for state in product((-1,0,1),repeat=len(y)):
        h=[[sum(a[i][j]*a[i][l]/sigma[i]**2 for i,s in enumerate(state) if s==0)for l in range(p)]for j in range(p)]
        b=[sum(a[i][j]*y[i]/sigma[i]**2 if s==0 else k*s*a[i][j]/sigma[i]for i,s in enumerate(state))for j in range(p)]
        x=solve(h,b)
        if x is None:continue
        r=[(yi-sum(ai[j]*x[j]for j in range(p)))/si for ai,yi,si in zip(a,y,sigma)]
        if any(abs(ri)>k if s==0 else s*ri<k for ri,s in zip(r,state)):continue
        score=[sum(ai[j]*max(-k,min(k,ri))/si for ai,ri,si in zip(a,r,sigma))for j in range(p)]
        assert score==[0]*p
        objective=sum(ri*ri/2 if abs(ri)<=k else k*abs(ri)-k*k/2 for ri in r)
        candidates[tuple(x)]={'parameters':[str(v)for v in x],'residuals':[str(yi-sum(ai[j]*x[j]for j in range(p)))for ai,yi in zip(a,y)],'standardizedResiduals':[str(v)for v in r],'objective':str(objective),'score':[str(v)for v in score]}
    assert candidates,model['id']
    objectives={v['objective']for v in candidates.values()};assert len(objectives)==1
    return {'id':model['id'],'input':model,'candidateMinima':list(candidates.values()),'multipleExactMinimizersFound':len(candidates)>1}

cases=[
 {'id':'position-outlier','A':[[1]]*4,'y':[0,0,0,10]},
 {'id':'position-flat','A':[[1]]*4,'y':[0,0,10,10]},
 {'id':'position-nonunit-sigma','A':[[1]]*4,'y':[0,0,0,10],'sigma':[1,1,2,1]},
 {'id':'clean-line','A':[[1,i]for i in range(4)],'y':[1,3,5,7]},
 {'id':'line-one-outlier','A':[[1,i]for i in range(6)],'y':[1,3,5,7,9,30]},
 {'id':'line-two-outliers','A':[[1,i]for i in range(7)],'y':[1,3,20,7,9,-8,13]},
 {'id':'line-nonunit-scales','A':[[1,i]for i in range(6)],'y':[1,3,5,7,9,30],'sigma':[1,2,1,3,1,2],'scale':2,'k':'1.5'},
 {'id':'two-dimensional-flat','A':[[1,0]]*4+[[0,1]]*4,'y':[0,0,10,10,0,0,10,10]},
 {'id':'high-leverage','A':[[1],[1],[100]],'y':[0,0,100]},
 {'id':'unique-on-breakpoint','A':[[1],[1]],'y':[0,2]},
 {'id':'tiny-flat-interval','A':[[1],[1]],'y':[0,'2.000000000001']},
 {'id':'near-breakpoint-unique','A':[[1],[1]],'y':[0,'1.999999999999']},
]
if __name__=='__main__':
    results=[exact(c)for c in cases]
    path=Path(__file__).with_name('huber-exact-cases.json');path.write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps([{'id':x['id'],'parameters':[v['parameters']for v in x['candidateMinima']],'objective':x['candidateMinima'][0]['objective']}for x in results],indent=2))
