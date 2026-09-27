#!/usr/bin/env python3
"""Independent GB/T24356 table43/table45 hierarchical scope oracle; no product import."""
from fractions import Fraction as F
from itertools import product
from pathlib import Path
import json,random
out=Path(__file__).parent
TREE={'data':(F(1,2),{'mathematical-accuracy':F(3,10),'observation-quality':F(4,10),'calculation-quality':F(3,10)}),'point':(F(3,10),{'selection-quality':F(1,2),'monument-quality':F(1,2)}),'materials':(F(1,5),{'presentation-quality':F(3,10),'completeness':F(7,10)})}
leaves=[x for _,cs in TREE.values() for x in cs]
def rat(f):return dict(numerator=str(f.numerator),denominator=str(f.denominator))
def grade(s):return 'excellent' if s>=90 else 'good' if s>=75 else 'qualified'
cases=[]
for mask in range(1,1<<7):
 scope=[x for i,x in enumerate(leaves) if mask>>i&1]
 elements={k:(w,{i:c for i,c in cs.items() if i in scope}) for k,(w,cs) in TREE.items() if any(i in scope for i in cs)}
 den=sum(w for w,cs in elements.values())
 for variant in range(4):
  scores={x:F([60,75,90,100][(i+variant)%4]) for i,x in enumerate(leaves) if x in scope};ew={};lw={};es={};score=F(0)
  for k,(w,cs) in elements.items():
   ew[k]=w/den;cd=sum(cs.values());lw[k]={i:c/cd for i,c in cs.items()};es[k]=sum(scores[i]*c for i,c in lw[k].items());score+=es[k]*ew[k]
  cases.append({'name':f'scope-{mask}-{variant}','scope':scope,'scores':{k:rat(v) for k,v in scores.items()},'expected':{'score':rat(score),'grade':grade(score),'elementWeights':{k:rat(v) for k,v in ew.items()},'leafWeights':{k:{j:rat(v) for j,v in cs.items()} for k,cs in lw.items()},'elementScores':{k:rat(v) for k,v in es.items()},'scopeCompleteness':'full-profile' if mask==127 else 'declared-partial-scope'}})
batches=[]
for n in range(1,31):
 for e in range(n+1):
  for g in range(n-e+1):
   q=n-e-g;r=F(e+g,n);er=F(e,n)
   batches.append({'e':e,'g':g,'q':q,'grade':'excellent' if r>=F(9,10) and er>=F(1,2) else 'good' if r>=F(4,5) and er>=F(3,10) else 'qualified'})
(out/'profile-boundaries.json').write_text(json.dumps({'source':'GB/T24356-2023 table43/table45; section6.2.3-6.2.5','profileCases':cases,'batchCases':batches},indent=2)+'\n')
print(json.dumps({'hierarchicalScopes':127,'scopeScoreCases':len(cases),'finalBatchCases':len(batches),'output':str(out/'profile-boundaries.json')}))
