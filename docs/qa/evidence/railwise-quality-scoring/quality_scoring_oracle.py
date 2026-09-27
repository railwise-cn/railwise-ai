#!/usr/bin/env python3
"""Independent GB/T 24356-2023 declared-inspection boundary oracle; no production imports."""
from fractions import Fraction as F
import json
from pathlib import Path

ROWS=[]
def result(state, **kw): return dict(state=state, **kw)
def calc(score, **kw): return result('calculated', score=F(score), **kw)
def fail(reason, **kw): return result('nonconforming', reason=reason, **kw)
def absent(reason): return result('unavailable', reason=reason)
def invalid(reason): return result('invalid', reason=reason)
def accuracy(m,m0):
    m,m0=F(m),F(m0)
    if m0<=0 or m<0: return invalid('accuracy_domain')
    if m>m0: return absent('accuracy_formula_outside_domain')
    return calc(100 if 10*m<=3*m0 else 60+F(400,7)*(m0-m)/m0)
def multiple(scores,weights=None):
    if not scores: return invalid('empty_accuracy_items')
    if any(s is None for s in scores): return absent('missing_accuracy_item')
    scores=list(map(F,scores))
    if any(s<60 or s>100 for s in scores): return invalid('accuracy_score_outside_formula_range')
    if len(scores)>1 and any(s==60 for s in scores): return absent('multiple_accuracy_equality_60')
    return weighted(scores,weights or [F(1,len(scores))]*len(scores))
def deduction(a,b,c,d,t='1'):
    if any(type(x) is not int or x<0 for x in [a,b,c,d]): return invalid('defect_count')
    t=F(t)
    if t<=0: return invalid('adjustment_coefficient')
    if a: return fail('a_class_veto', fixedADeduction=42*a)
    if t!=1: return absent('adjusted_t_not_in_minimal_contract')
    s=100-(12*b+4*c+d)/t
    return fail('subelement_below_60',rawScore=s) if s<60 else calc(s)
def weighted(scores,weights):
    if len(scores)!=len(weights) or not scores: return invalid('weight_shape')
    weights=list(map(F,weights))
    if min(weights)<=0 or sum(weights)!=1: return invalid('weights_positive_sum_one')
    return calc(sum(F(s)*w for s,w in zip(scores,weights)))
def grade(s):
    s=F(s)
    if s<60:return fail('score_below_60')
    if s>100:return invalid('score_above_100')
    return calc(s,grade='excellent' if s>=90 else 'good' if s>=75 else 'qualified')
def unit(scores,weights,a=0,complete=True):
    if a is not None and a>0:return fail('a_class_veto')
    if any(s is not None and F(s)<60 for s in scores):return fail('child_below_60')
    if not complete or a is None or any(s is None for s in scores):return absent('incomplete_unit_evidence')
    w=weighted(scores,weights)
    return grade(w['score']) if w['state']=='calculated' else w
def sample(units):
    if not units:return invalid('empty_sample')
    if any(u['state']=='nonconforming' for u in units):return fail('sample_has_failed_unit')
    if any(u['state']!='calculated' for u in units):return absent('sample_has_unresolved_unit')
    return grade(sum(u['score'] for u in units)/len(units))
def overview(a,b):
    if a is not None and a>0 or b is not None and b>=4:return fail('overview_defects')
    if a is None or b is None:return absent('overview_missing_evidence')
    return result('calculated',qualified=True)
def final_batch(e,g,q,qualified=True,complete=True):
    if any(type(x) is not int or x<0 for x in [e,g,q]) or e+g+q==0:return invalid('batch_counts')
    if qualified is False:return fail('batch_prerequisite_failed')
    if qualified is not True or not complete:return absent('batch_prerequisite_missing')
    n=e+g+q
    gr='excellent' if 10*(e+g)>=9*n and 2*e>=n else 'good' if 5*(e+g)>=4*n and 10*e>=3*n else 'qualified'
    return result('calculated',grade=gr,count=n,excellentRate=F(e,n),excellentGoodRate=F(e+g,n))
def acceptance(detailed,ov,fabricated=False,major=False):
    if fabricated or major:return fail('batch_fabrication_or_major_route_veto')
    if detailed=='failed' or ov=='failed':return fail('inspection_failed')
    if fabricated is None or major is None:return absent('batch_veto_evidence_missing')
    if detailed!='qualified' or ov not in ['qualified','not_performed']:return absent('inspection_unresolved')
    return result('calculated',qualified=True)
def hierarchical_partial(scope,values):
    # A .5 -> a .3,b .7; B .3 -> c .5,d .5; C .2 -> e 1.
    tree={'A':(F('0.5'),{'a':F('0.3'),'b':F('0.7')}),'B':(F('0.3'),{'c':F('0.5'),'d':F('0.5')}),'C':(F('0.2'),{'e':F(1)})}
    if not scope:return invalid('empty_scope')
    if any(k not in tree or not kids or any(x not in tree[k][1] for x in kids) for k,kids in scope.items()):return invalid('unknown_scope')
    if any(x not in values for kids in scope.values() for x in kids):return absent('missing_included_scope_value')
    total=sum(tree[k][0] for k in scope);out=F(0);ew={};lw={}
    for k,kids in scope.items():
        w,child=tree[k];ew[k]=w/total;den=sum(child[x] for x in kids)
        lw[k]={x:child[x]/den for x in kids}
        out+=ew[k]*sum(F(values[x])*lw[k][x] for x in kids)
    return calc(out,elementWeights=ew,childWeights=lw,scopeLabel='declared_partial_scope_only')
def check(name,operation,inputs,expected,call):
    actual=call()
    for k,v in expected.items():assert actual.get(k)==v,(name,k,actual,v)
    ROWS.append(dict(id=name,operation=operation,input=inputs,expected=actual))

eps=F(1,1000000)
for label,m,expect in [('zero',F(0),F(100)),('below_03',F('0.3')-eps,F(100)),('at_03',F('0.3'),F(100)),('above_03',F('0.3')+eps,F(100)-F(400,7)*eps),('below_limit',1-eps,F(60)+F(400,7)*eps),('at_limit',F(1),F(60))]:
    check('accuracy_'+label,'accuracy',dict(m=m,m0=1),dict(state='calculated',score=expect),lambda m=m:accuracy(m,1))
check('accuracy_above_limit','accuracy',dict(m=1+eps,m0=1),dict(state='unavailable'),lambda:accuracy(1+eps,1))
for label,m,m0 in [('zero_limit',0,0),('negative_limit',0,-1),('negative_detection',-1,1)]:
    check('accuracy_'+label,'accuracy',dict(m=m,m0=m0),dict(state='invalid'),lambda m=m,m0=m0:accuracy(m,m0))
check('accuracy_scale_units','accuracy',dict(m='0.006',m0='0.01'),dict(score=F(580,7)),lambda:accuracy('0.006','0.01'))
for name,scores,weights,exp in [('single_60',[60],None,dict(score=F(60))),('multi_equal_60',[60,100],None,dict(state='unavailable')),('multi_above_60',[60+eps,100],None,dict(score=80+eps/2)),('multi_weighted',[80,100],[F(1,4),F(3,4)],dict(score=F(95))),('multi_missing',[None,100],None,dict(state='unavailable')),('multi_below_60',[59,100],None,dict(state='invalid')),('invalid_weight_sum',[80,100],[F(1,3),F(1,3)],dict(state='invalid'))]:
    check(name,'accuracy_aggregate',dict(scores=scores,weights=weights),exp,lambda scores=scores,weights=weights:multiple(scores,weights))
for name,a,b,c,d,t,exp in [('deduct_exact_60',0,3,1,0,1,dict(score=F(60))),('deduct_below_60',0,3,1,1,1,dict(state='nonconforming',rawScore=F(59))),('deduct_negative_no_clamp',0,9,0,0,1,dict(rawScore=F(-8))),('deduct_a_veto',1,0,0,0,1,dict(state='nonconforming',fixedADeduction=42)),('deduct_t_zero',0,0,0,0,0,dict(state='invalid')),('deduct_adjusted_t',0,1,0,0,2,dict(state='unavailable')),('deduct_negative_count',0,-1,0,0,1,dict(state='invalid'))]:
    check(name,'deduction',dict(a=a,b=b,c=c,d=d,t=t),exp,lambda a=a,b=b,c=c,d=d,t=t:deduction(a,b,c,d,t))
for s in [60-eps,60,60+eps,75-eps,75,75+eps,90-eps,90,90+eps,100]:
    exp={'state':'nonconforming'} if s<60 else {'grade':'excellent' if s>=90 else 'good' if s>=75 else 'qualified'}
    check('grade_'+str(s),'grade',dict(score=s),exp,lambda s=s:grade(s))
for name,scores,a,complete,exp in [('child_59_veto',[59,100],0,True,dict(state='nonconforming')),('child_60_allowed',[60,100],0,True,dict(grade='excellent',score=F(498,5))),('a_overrides_high_scores',[100,100],1,True,dict(state='nonconforming')),('missing_child_not_excluded',[None,100],0,True,dict(state='unavailable')),('unknown_a_evidence',[100,100],None,True,dict(state='unavailable')),('incomplete_evidence',[100,100],0,False,dict(state='unavailable')),('known_child_fail_with_missing',[59,None],0,False,dict(state='nonconforming'))]:
    check(name,'unit',dict(scores=scores,weights=[F(1,100),F(99,100)],a=a,complete=complete),exp,lambda scores=scores,a=a,complete=complete:unit(scores,[F(1,100),F(99,100)],a,complete))
check('partial_hierarchical_normalization','hierarchical_partial',dict(scope={'A':['a'],'B':['c','d']},values={'a':60,'c':80,'d':100}),dict(score=F(285,4),elementWeights={'A':F(5,8),'B':F(3,8)},childWeights={'A':{'a':F(1)},'B':{'c':F(1,2),'d':F(1,2)}}),lambda:hierarchical_partial({'A':['a'],'B':['c','d']},{'a':60,'c':80,'d':100}))
check('partial_missing_included_leaf','hierarchical_partial',dict(scope={'A':['a','b']},values={'a':100}),dict(state='unavailable'),lambda:hierarchical_partial({'A':['a','b']},{'a':100}))
for name,units,exp in [('sample_one_failure',[grade(59),grade(100)],dict(state='nonconforming')),('sample_mean',[grade(60),grade(100)],dict(score=F(80),grade='good')),('sample_missing',[grade(100),absent('missing')],dict(state='unavailable')),('sample_fail_over_missing',[grade(59),absent('missing')],dict(state='nonconforming'))]:
    check(name,'sample',dict(units=units),exp,lambda units=units:sample(units))
for name,a,b,exp in [('overview_b3',0,3,'calculated'),('overview_b4',0,4,'nonconforming'),('overview_a',1,0,'nonconforming'),('overview_unknown',None,0,'unavailable')]:
    check(name,'overview',dict(a=a,b=b),dict(state=exp),lambda a=a,b=b:overview(a,b))
for name,e,g,q,pre,comp,exp in [('final_excellent_equal',5,4,1,True,True,dict(grade='excellent')),('final_excellent_below_rate',50,39,11,True,True,dict(grade='good')),('final_excellent_below_e',49,41,10,True,True,dict(grade='good')),('final_good_equal',3,5,2,True,True,dict(grade='good')),('final_good_below_rate',30,49,21,True,True,dict(grade='qualified')),('final_good_below_e',29,51,20,True,True,dict(grade='qualified')),('final_prerequisite_failed',5,4,1,False,True,dict(state='nonconforming')),('final_prerequisite_missing',5,4,1,None,True,dict(state='unavailable')),('final_counts_incomplete',5,4,1,True,False,dict(state='unavailable')),('final_rounding_not_allowed',4999,4001,1000,True,True,dict(grade='good'))]:
    check(name,'final_batch',dict(e=e,g=g,q=q,qualified=pre,complete=comp),exp,lambda e=e,g=g,q=q,pre=pre,comp=comp:final_batch(e,g,q,pre,comp))
for name,d,ov,f,m,exp in [('accept_both_pass','qualified','qualified',False,False,'calculated'),('accept_only_detailed','qualified','not_performed',False,False,'calculated'),('accept_overview_pending','qualified','pending',False,False,'unavailable'),('accept_overview_missing','qualified',None,False,False,'unavailable'),('accept_overview_fail','qualified','failed',False,False,'nonconforming'),('accept_detailed_pending','pending','not_performed',False,False,'unavailable'),('accept_fabricated','qualified','qualified',True,False,'nonconforming'),('accept_major_route','qualified','qualified',False,True,'nonconforming'),('accept_veto_with_missing','pending',None,True,False,'nonconforming'),('accept_unknown_veto','qualified','qualified',None,False,'unavailable')]:
    check(name,'acceptance_batch',dict(detailed=d,overview=ov,fabricated=f,major=m),dict(state=exp),lambda d=d,ov=ov,f=f,m=m:acceptance(d,ov,f,m))

def encode(v):
    if isinstance(v,F):return {'numerator':str(v.numerator),'denominator':str(v.denominator)}
    if isinstance(v,dict):return {k:encode(x) for k,x in v.items()}
    if isinstance(v,list):return list(map(encode,v))
    return v
out=dict(schema='railwise-quality-scoring-independent-oracle-v1',standard='GB/T 24356-2023',pdfSha256='96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487',passed=len(ROWS),cases=ROWS,limitations=['Independent declared-input boundary oracle; not implementation acceptance or professional approval.','Unavailable branches encode the documented conservative minimal contract.'])
path=Path(__file__).with_name('quality-scoring-boundaries.json');path.write_text(json.dumps(encode(out),ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':len(ROWS),'output':str(path)}))
