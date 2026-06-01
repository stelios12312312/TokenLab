import numpy as np
import scipy.stats
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
from TokenLab.simulationcomponents.agentpoolclasses import *
from TokenLab.simulationcomponents.pricingclasses import *
from TokenLab.simulationcomponents.supplyclasses import *
from TokenLab.simulationcomponents.addons import *
from TokenLab.utils.helpers import *

# Basic Parameters
INITIAL_PRICE = 0.01
SUPPLY = 200_000_000
FEE = 0.0001

# Given Data
NUM_USERS = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000]
# TRANS = [18004, 108271, 181408, 336604, 755024, 1368143, 1372345, 1376556, 1380775, 1385002, 1389236, 1393480, 1397731, 1401990, 1406258, 1410534, 1414818, 1419110, 1423410, 1318593]
ITERATIONS = 24

# Interpolate NUM_USERS to match the length of TRANS
interpolated_users = np.interp(np.linspace(0, len(NUM_USERS) - 1, ITERATIONS), np.arange(len(NUM_USERS)), NUM_USERS).astype(int)

# Custom Distributions
bet_amounts = np.array([1, 5, 25, 100])*0.5
bet_probabilities = [0.70, 0.20, 0.08, 0.02]
custom_bet_distribution = scipy.stats.rv_discrete(name='custom_bet_distribution', values=(bet_amounts, bet_probabilities))

transaction_counts = np.array([10, 20, 50])*0.5
transaction_probabilities = [0.60, 0.30, 0.10]
custom_transaction_distribution = scipy.stats.rv_discrete(name='custom_transaction_distribution', values=(transaction_counts, transaction_probabilities))



# Token Pools
token_data = [
    (110000000, 24, 18),
    (50000000, 18, 12),
    (25000000, 12, 12),
    (67200000, 15, 12),
    (336000000, 15, 24),
    (63000000, 15, 24),
    (210000000, 3, 12),
    (252000000, 12, 24),
    (168000000, 12, 24),
    (84000000, 18, 12),
    (147000000, 24, 18),
    (105000000, 15, 12),
    (126000000, 15, 30),
    (42000000, 15, 24),
    (42000000, 15, 24),
    (84000000, 12, 24)
]

token_pools = []
for amount, cliff, vesting in token_data:
    pool = SupplyController_CliffVesting(amount, vesting, cliff)
    token_pools.append(pool)


# User Growth
class UserGrowth_FromData(UserGrowth):
    def __init__(self, data: list):
        super(UserGrowth_FromData, self).__init__()
        self._num_users_store = np.ndarray.flatten(np.array(data))
        
    def get_current_users(self):
        # Get the current number of users based on the iteration
        return self._num_users_store[self.iteration % len(self._num_users_store)]

user_growth = UserGrowth_FromData(interpolated_users)

# Transaction Management with Stochastic Parameters
transactions = TransactionManagement_Stochastic(
    value_distribution=custom_bet_distribution,
    value_dist_parameters={},
    transactions_distribution=custom_transaction_distribution,
    transactions_dist_parameters={}
)

# Holding Time
holding_time = HoldingTime_Stochastic()

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$')

# Token Economy Setup
te = TokenEconomy_Basic(
    holding_time=holding_time,
    supply=SUPPLY,
    token='token',
    initial_price=INITIAL_PRICE,
    price_function=PriceFunction_LinearRegression,
    burn_token=False,
    burn_coefficient=0.00,
    supply_is_added=True
)

# Add the agent pool to the token economy
te.add_agent_pool(ap_fiat)
te.add_supply_pools(token_pools)


# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=100)

# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
_, token_price_timeseries = meta.get_timeseries('token_price', multiple=50)

