import numpy as np
import scipy
import sys
import os
import pandas as pd
from matplotlib import pyplot as plt

tokenlab_path = os.path.abspath("").replace('projects', 'src')
sys.path.insert(0, tokenlab_path)

from TokenLab.simulationcomponents import *
from TokenLab.simulationcomponents.usergrowthclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.tokeneconomyclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.agentpoolclasses import *
from TokenLab.simulationcomponents.pricingclasses import *
from TokenLab.simulationcomponents.supplyclasses import *
from TokenLab.simulationcomponents.addons import *
from TokenLab.utils.helpers import *

# Basic Parameters
INITIAL_PRICE = 0.01
SUPPLY = 1_000_000_000
#MAX_USERS = 5_000_000  # Maximum number of users
FEE = 0.0001





TRANS = [18004, 108271, 181408, 336604, 755024, 1368143, 1372345, 1376556, 1380775, 1385002, 1389236, 1393480, 1397731, 1401990, 1406258, 1410534, 1414818, 1419110, 1423410, 1318593]

ITERATIONS=len(TRANS)

user_growth = UserGrowth_Constant(1)
transactions = TransactionManagement_FromData([18004, 108271, 181408, 336604, 755024, 1368143, 1372345, 1376556, 1380775, 1385002, 1389236, 1393480, 1397731, 1401990, 1406258, 1410534, 1414818, 1419110, 1423410, 1318593])


holding_time = HoldingTime_Stochastic()

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$')


te = TokenEconomy_Basic(
    holding_time=holding_time, 
    supply=SUPPLY, 
    token='MRG', 
    initial_price=INITIAL_PRICE,
    price_function=PriceFunction_LinearRegression, 
    burn_token=False,
    burn_coefficient=0.00,
    supply_is_added=True
)

# Add the agent pool to the token economy
# te.add_agent_pools([ap_fiat, ap_fiat_new])
te.add_agent_pool(ap_fiat)

# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=100)

# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
_,token_price_timeseries = meta.get_timeseries('MRG_price',multiple=50)
