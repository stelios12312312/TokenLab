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
INITIAL_PRICE = 1.48
#MAX_USERS = 5_000_000  # Maximum number of users

supply_values = [
    150000, 213333, 276667, 340000, 450833, 561667, 672500, 809722, 946944,
    1084167, 1238981, 1393796, 1548611, 1674398, 1800185, 1925972, 2004259,
    2082546, 2160833, 2212731, 2264630, 2316528, 2368426, 2420324, 2472222,
    2524120, 2576019, 2627917, 2662222, 2696528, 2730833, 2765139, 2799444,
    2833750, 2868056, 2902361, 2936667
]

SUPPLY = SupplyController_FromData(values=supply_values)  # Total token supply for pools
# SUPPLY = 20_000_000
ITERATIONS = len(supply_values)

STARTING_VOLUME = 100_000/1
FINAL_VOLUME = 8_500_000/1

user_growth = UserGrowth_Constant(1)
transactions = TransactionManagement_Trend(average_transaction_initial=STARTING_VOLUME,  
                                            # space_function=log_saturated_space,
                                           average_transaction_final=FINAL_VOLUME,
                                           num_steps=ITERATIONS,noise_addons = [AddOn_MultiplierTimed(0.5,[0,12])])


holding_time = HoldingTime_Stochastic()

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$')


te = TokenEconomy_Basic(
    holding_time=holding_time, 
    supply=SUPPLY, 
    token='VGN', 
    initial_price=INITIAL_PRICE,
    price_function=PriceFunction_LinearRegression, 
    burn_token=False,
    burn_coefficient=0.00,
    safeguard_current_supply_level=True,
    supply_is_added=False,
    multiple=1
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
_,token_price_timeseries = meta.get_timeseries('VGN_price')
_,transactions_timeseries = meta.get_timeseries('transactions_$')


plt.hist(holding_time.sample())
plt.xlabel('months')
plt.ylabel('frequency')