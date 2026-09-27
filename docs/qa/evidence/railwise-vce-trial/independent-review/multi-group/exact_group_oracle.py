#!/usr/bin/env python3
"""Independent exact condition-space first-step oracle, no product modules."""
from fractions import Fraction as F
from pathlib import Path
import random,json

def mat(rows):return [[F(v) for v in row] for row in rows]
def tr(a):return [list(r) for r in zip(*a)]
def mul(a,b):return [[sum((x*y for x,y in zip(r,c)),F(0)) for c in tr(b)] for r in a]
def eye(n):return [[F(i==j) for j in range(n)] for i in range(n)]
def inv(a):
 n=len(a);m=[list(r)+e for r,e in zip(a,eye(n))]
 for j in range(n):
  pivot=next((i for i in range(j,n) if m[i][j]),None)
  if pivot is None:raise ValueError('singular')
  m[j],m[pivot]=m[pivot],m[j];v=m[j][j];m[j]=[x/v for x in m[j]]
  for i in range(n):
   if i==j:continue
   v=m[i][j];m[i]=[x-v*y for x,y in zip(m[i],m[j])]
 return [r[n:] for r in m]
def trace(a):return sum((a[i][i] for i in range(len(a))),F(0))
def nullspace(a):
 m=[list(r) for r in a];columns=len(m[0]);pivotcols=[];i=0
 for j in range(columns):
  pivot=next((r for r in range(i,len(m)) if m[r][j]),None)
  if pivot is None:continue
  m[i],m[pivot]=m[pivot],m[i];v=m[i][j];m[i]=[x/v for x in m[i]]
  for r in range(len(m)):
   if r==i:continue
   v=m[r][j];m[r]=[x-v*y for x,y in zip(m[r],m[i])]
  pivotcols.append(j);i+=1
  if i==len(m):break
 basis=[]
 for free in range(columns):
  if free in pivotcols:continue
  b=[F(0)]*columns;b[free]=F(1)
  for r,j in enumerate(pivotcols):b[j]=-m[r][free]
  basis.append(b)
 return tr(basis),len(pivotcols)
def solve(A,y,q,groups,theta):
 A=mat(A);y=mat([[v] for v in y]);q=list(map(F,q));theta=list(map(F,theta));B,rank=nullspace(tr(A));r=len(B[0]);k=len(theta);n=len(y)
 if rank!=len(A[0]):raise ValueError('design rank')
 zero=mat([[0]*r for _ in range(r)])
 projected=[mul(mul(tr(B),[[q[i] if i==j and groups[i]==g else F(0) for j in range(n)] for i in range(n)]),B) for g in range(k)]
 covariance=[[sum((theta[g]*projected[g][i][j] for g in range(k)),F(0)) for j in range(r)] for i in range(r)]
 W=inv(covariance);t=mul(tr(B),y);Wt=mul(W,t)
 normal=[[trace(mul(mul(mul(W,pg),W),ph))/2 for ph in projected] for pg in projected]
 rhs=[[mul(mul(tr(Wt),pg),Wt)[0][0]/2] for pg in projected]
 try:candidate=mul(inv(normal),rhs)
 except ValueError:return {'status':'unidentifiable','normal':normal,'rhs':rhs}
 scale=min(theta[g]*q[i] for i,g in enumerate(groups))
 return {'status':'nonpositive-component' if any(v[0]<=0 for v in candidate) else 'positive-candidate','candidate':[v[0] for v in candidate],
  'normal':normal,'rhs':rhs,'normalizedNormal':[[v*scale**2 for v in row] for row in normal],'normalizedRhs':[v[0]*scale**2 for v in rhs], 'covarianceScale':scale}

def request(A,y,q,groups,theta,i):
 return {'schemaVersion':1,'model':'fixed-linear-independent-disjoint-variance-groups','unit':'mm','parameterIds':[f'x{j}' for j in range(len(A[0]))],
  'groups':[{'id':f'g{j}','initialVariance':v,'sourceAnchor':'independent-Fraction'} for j,v in enumerate(theta)],
  'observations':[{'id':f'o{j}','value':v,'coefficients':A[j],'groupId':f'g{groups[j]}','relativeVariance':q[j],'sourceAnchor':'independent-Fraction'} for j,v in enumerate(y)],
  'maxIterations':1,'relativeTolerance':1e-12}
rng=random.Random(20260920);cases=[]
for i in range(160):
 n=rng.choice([4,5,6,7]);p=rng.randrange(1,min(3,n-1)+1);k=rng.choice([2,3])
 while True:
  A=[[rng.randrange(-3,4) for _ in range(p)] for _ in range(n)];y=[rng.randrange(-10,11) for _ in range(n)]
  q=[rng.randrange(1,5) for _ in range(n)];groups=[j%k for j in range(n)];rng.shuffle(groups);theta=[rng.randrange(1,5) for _ in range(k)]
  try: expected=solve(A,y,q,groups,theta)
  except (ValueError,ZeroDivisionError):continue
  break
 cases.append({'id':i,'request':request(A,y,q,groups,theta,i),'expected':expected})
# Exact published first step with decimal strings represented as Fractions.
example=solve([[1]]*4,list(map(F,['1.6','.9','-.9','3.6'])),[1]*4,[0,0,1,1],[1,1])
assert example['candidate']==[F(-37,25),F(42,5)]
output={'oracle':'independent-exact-rational-condition-space-vce-first-step-1','seed':20260920,'publishedExample':example,'cases':cases}
Path(__file__).with_name('exact_group_oracle.json').write_text(json.dumps(output,default=lambda v:str(v) if isinstance(v,F) else v,indent=2)+'\n')
print('160 independent first-step cases generated; exact paper example:',example['candidate'])
