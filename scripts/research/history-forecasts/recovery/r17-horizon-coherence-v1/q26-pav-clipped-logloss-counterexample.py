"""Synthetic exact counterexample only. No historical data/source imports."""
from fractions import Fraction as F
import hashlib
import json
import math
from pathlib import Path

eps = 1e-6
e = F.from_float(eps)
p = (2*e, F(0), F(1), F(1), F(1))
q = (e, e, F(1), F(1), F(1))
y = (F(1),)*5
assert (p[0]+p[1])/2 == q[0] == q[1]
assert all(a<=b for a,b in zip(q,q[1:]))
clip = lambda x: max(e, min(1-e, x))
product = lambda values: math.prod(values)
original_product = product(map(clip,p))
projected_product = product(map(clip,q))
assert original_product == 2*projected_product
before_brier = sum((x-1)**2 for x in p)
after_brier = sum((x-1)**2 for x in q)
assert before_brier-after_brier == 2*e**2
pf, qf = tuple(map(float,p)), tuple(map(float,q))
fclip = lambda x:max(eps,min(1-eps,x))
ll = lambda values: math.fsum(-math.log(fclip(x)) for x in values)
# Rational decimal epsilon has the same symbolic ratios but a different dyadic value.
d = F(1,10**6)
assert (1-2*d)**2+1-2*(1-d)**2 == 2*d*d
r=dict(scope='Synthetic five-H nested labels, equal-weight PAV, epsilon-clipped binary logloss.',
       epsilon_float=eps, epsilon_exact_binary64=str(e), epsilon_exact_decimal=str(d),
       original_probabilities=list(pf), projected_probabilities=list(qf), labels=[1]*5,
       clipped_likelihood_before_divided_by_after=str(original_product/projected_product),
       clipped_summed_LL_after_minus_before_exact='ln(2)',
       clipped_summed_LL_before_float=ll(pf), clipped_summed_LL_after_float=ll(qf),
       clipped_summed_LL_after_minus_before_float=ll(qf)-ll(pf), math_log_2=math.log(2),
       exact_summed_Brier_before_minus_after=str(before_brier-after_brier),
       exact_summed_Brier_reduction_float=float(2*e**2),
       ordinary_float_summed_Brier_reduction=sum((x-1)**2 for x in pf)-sum((x-1)**2 for x in qf),
       decimal_epsilon_exact_Brier_reduction=str(2*d*d),
       unclipped_LL_before='positive infinity because p_H12=0 with y_H12=1',
       unclipped_LL_after='finite because projected probabilities are strictly positive at all positive labels',
       conclusion='Clipped summed logloss worsens by ln(2) while summed Brier improves. No change to O92 no-logloss-guarantee scope.',
       source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
out=Path('/private/tmp/q26-pav-clipped-logloss-counterexample.json')
out.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r,indent=2));print('JSON_SHA256',hashlib.sha256(out.read_bytes()).hexdigest())
