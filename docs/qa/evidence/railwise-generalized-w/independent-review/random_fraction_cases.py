#!/usr/bin/env python3
"""Seeded independent exact cases. Product code is not imported or called."""
import runpy,random,json,argparse,contextlib,io
from pathlib import Path
from fractions import Fraction as F
root=Path(__file__).parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', required=True)
output_dir=Path(parser.parse_args().output_dir).resolve()
output_dir.mkdir(parents=True,exist_ok=True)
with contextlib.redirect_stdout(io.StringIO()):
 oracle=runpy.run_path(str(root/'fraction_oracle.py'))
solve=oracle['solve'];mm=oracle['multiply'];tr=oracle['transpose'];mat=oracle['matrix']
rng=random.Random(20260920)
cases=[]
for number in range(96):
 n=rng.choice([3,4,5,6]);p=rng.randrange(1,min(3,n-1)+1)
 while True:
  A=[[rng.randrange(-4,5) for _ in range(p)] for _ in range(n)]
  B=[[rng.randrange(-3,4) for _ in range(n)] for _ in range(n)]
  C=mm(mat(B),tr(mat(B)))
  for i in range(n):C[i][i]+=rng.randrange(1,5)
  y=[[rng.randrange(-20,21)] for _ in range(n)]
  directions={f'c{k}':[[rng.randrange(-5,6)] for _ in range(n)] for k in range(4)}
  directions['column-space']=[[row[0]] for row in A]
  try: expected=solve(A,y,C,directions)
  except (ValueError,AssertionError,ZeroDivisionError):continue
  break
 request={'schemaVersion':1,'model':'fixed-linear-full-column-rank','purpose':'declared-model-readonly-diagnostic','residualConvention':'observed-minus-adjusted',
  'observationUnit':'synthetic','observationIds':[f'o{i}' for i in range(n)],'parameterIds':[f'p{i}' for i in range(p)],'parameterUnits':['synthetic']*p,
  'designMatrix':A,'observations':[row[0] for row in y],
  'covariance':{'kind':'known-apriori-absolute-observation-covariance','basisStatement':'Independent seed-20260920 exact integer SPD synthetic review only.','matrix':[[int(x) for x in row] for row in C]},
  'family':{'id':f'case-{number}','alpha':.05,'tail':'two-sided','declaration':'caller-declared-before-evaluation'},
  'biasDirections':[{'id':key,'coefficients':[int(row[0]) for row in c]} for key,c in directions.items()]}
 cases.append({'case':number,'request':request,'expected':expected})
(output_dir/'random_fraction_cases.json').write_text(json.dumps({'seed':20260920,'count':len(cases),'cases':cases},default=lambda x:str(x) if isinstance(x,F) else x,indent=2)+'\n')
print(f'{len(cases)} independent exact cases generated')
