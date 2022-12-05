import numpy as np
import scipy
import sys
sys.path.insert(0,'..')

from simulationcomponents import *
from simulationcomponents.usergrowthclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.tokeneconomyclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.agentpoolclasses import *
from simulationcomponents.pricingclasses import *
from simulationcomponents.supplyclasses import *
from simulationcomponents.addons import Condition
from utils.helpers import *
from matplotlib import pyplot as plt


ITERATIONS=60
HOLDING_TIME=HoldingTime_Adaptive(1)
SUPPLY=10**7
INITIAL_PRICE=1

usm_fiat=UserGrowth_Spaced(100,54000,ITERATIONS,log_saturated_space,use_difference=False)


ap_fiat=AgentPool_Basic(users_controller=usm_fiat,transactions_controller=1000,currency='$')
plt.plot(usm_fiat._num_users_store)