#!/usr/bin/env python3
"""80-digit condition-space iteration, independent of product implementation."""
from decimal import Decimal as D, localcontext
from fractions import Fraction as F
from pathlib import Path
import json,runpy
root=Path(__file__).parent
helpers=runpy.run_path(str(root/'exact_group_oracle.py'))

def transpose(a):return [list(r) for r in zip(*a)]
def multiply(a,b):return [[sum((x*y for x,y in zip(r,c)),D(0)) for c in transpose(b)] for r in a]
def inverse(a):
 n=len(a);m=[r+[D(i==j) for j in range(n)] for i,r in enumerate(a)]
 for j in range(n):
  pivot=max(range(j,n),key=lambda i:abs(m[i][j]))
  if abs(m[pivot][j])<D('1e-65'):raise ValueError('rank-unresolved')
  m[j],m[pivot]=m[pivot],m[j];v=m[j][j];m[j]=[x/v for x in m[j]]
  for i in range(n):
   if i==j:continue
   v=m[i][j];m[i]=[x-v*y for x,y in zip(m[i],m[j])]
 return [r[n:] for r in m]
def trace(a):return sum((a[i][i] for i in range(len(a))),D(0))
def number(v):
 if isinstance(v,F):return D(v.numerator)/D(v.denominator)
 return D(str(v))
def run(request):
 with localcontext() as ctx:
  ctx.prec=80
  rows=request['observations'];n=len(rows);p=len(request['parameterIds']);k=len(request['groups'])
  A=[[number(x) for x in o['coefficients']] for o in rows];y=[[number(o['value'])] for o in rows];q=[number(o['relativeVariance']) for o in rows]
  groups=[next(g for g,group in enumerate(request['groups']) if group['id']==o['groupId']) for o in rows]
  exactB,rank=helpers['nullspace'](helpers['tr'](helpers['mat']([o['coefficients'] for o in rows])))
  B=[[number(x) for x in row] for row in exactB];r=n-p;t=multiply(transpose(B),y)
  P=[multiply(multiply(transpose(B),[[q[i] if i==j and groups[i]==g else D(0) for j in range(n)] for i in range(n)]),B) for g in range(k)]
  theta=[number(g['initialVariance']) for g in request['groups']];steps=[];out={'steps':steps}
  for iteration in range(1,request['maxIterations']+1):
   covariance=[[sum((theta[g]*P[g][i][j] for g in range(k)),D(0)) for j in range(r)] for i in range(r)]
   try:
    W=inverse(covariance);Wt=multiply(W,t)
    normal=[[trace(multiply(multiply(multiply(W,pg),W),ph))/2 for ph in P] for pg in P]
    rhs=[[multiply(multiply(transpose(Wt),pg),Wt)[0][0]/2] for pg in P]
    candidate=[row[0] for row in multiply(inverse(normal),rhs)]
   except ValueError:return {**out,'outcome':'stochastic-rank-or-conditioning'}
   change=max(abs(a-b)/max(abs(a),abs(b)) for a,b in zip(theta,candidate))
   steps.append({'current':[str(x) for x in theta],'candidate':[str(x) for x in candidate],'change':str(change)})
   if any(v<=0 for v in candidate):return {**out,'outcome':'nonpositive-component'}
   if any(v<D('1e-18') or v>D('1e18') for v in candidate):return {**out,'outcome':'numerical-boundary'}
   theta=candidate
   if change<=number(request['relativeTolerance']):
    w=[1/(theta[g]*q[i]) for i,g in enumerate(groups)]
    weightedA=[[v*w[i] for v in row] for i,row in enumerate(A)]
    x=multiply(multiply(inverse(multiply(transpose(A),weightedA)),transpose(weightedA)),y)
    adjusted=multiply(A,x)
    return {**out,'outcome':'converged','components':[str(v) for v in theta],'parameters':[str(v[0]) for v in x],'residuals':[str(y[i][0]-adjusted[i][0]) for i in range(n)]}
  return {**out,'outcome':'iteration-limit'}

cases=json.loads((root/'exact_group_oracle.json').read_text())['cases']
selected=[c for c in cases if c['expected']['status']=='positive-candidate'][:24]+[c for c in cases if c['expected']['status']=='nonpositive-component'][:6]
requests=[]
for c in selected:
 r=c['request'];r['maxIterations']=100;r['relativeTolerance']=1e-10;requests.append({'id':f'random-{c["id"]}','request':r})
for initial in [[1,1],[1,10]]:
 r=helpers['request']([[1]]*4,[1.6,.9,-.9,3.6],[1]*4,[0,0,1,1],initial,'paper');r['maxIterations']=100;r['relativeTolerance']=1e-10
 requests.append({'id':f'paper-{initial[1]}','request':r})
result={'method':'80-digit-decimal-condition-space-iteration','cases':[{'id':r['id'],'request':r['request'],'expected':run(r['request'])} for r in requests]}
(root/'decimal_iteration_cases.json').write_text(json.dumps(result,indent=2)+'\n')
print({r['id']:(r['expected']['outcome'],len(r['expected']['steps'])) for r in result['cases']})
