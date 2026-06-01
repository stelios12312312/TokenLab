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
ITERATIONS = 24
INITIAL_PRICE = 0.001
SUPPLY = 645_000_000  # Total token supply for pools
MAX_USERS = 5_000_000  # Maximum number of users
FEE = 0.0001

NUM_HEDI_PER_MONTH = 1
HEDI_COST = 4_500

STARTING_VOLUME = 1*HEDI_COST*0.66
FINAL_VOLUME = 100*HEDI_COST*0.66

user_growth = UserGrowth_Constant(1)
transactions = TransactionManagement_Trend(average_transaction_initial=STARTING_VOLUME,  
                                           space_function=log_saturated_space,
                                           average_transaction_final=FINAL_VOLUME,
                                           num_steps=ITERATIONS)


holding_time = HoldingTime_Stochastic()

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$')


te = TokenEconomy_Basic(
    holding_time=holding_time, 
    supply=SUPPLY, 
    token='HAI', 
    initial_price=INITIAL_PRICE,
    # price_function=PriceFunction_LinearRegression, 
    burn_token=True,
    burn_coefficient=0.5
)

# Add the agent pool to the token economy
# te.add_agent_pools([ap_fiat, ap_fiat_new])
te.add_agent_pool(ap_fiat)

# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=200)

# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
token_price_timeseries = meta.get_timeseries('HAI_price',multiple=50)