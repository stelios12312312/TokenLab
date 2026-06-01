#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Thu Aug 31 16:16:29 2023

@author: stylianoskampakis
"""


import numpy as np
import scipy
import sys
import os

import pandas as pd

try:
    import TokenLab
except:
    tokenlab_path=os.path.abspath("").replace('projects','src')
    sys.path.insert(0,tokenlab_path)


from TokenLab.simulationcomponents import *
from TokenLab.simulationcomponents.usergrowthclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.tokeneconomyclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.agentpoolclasses import *
from TokenLab.simulationcomponents.pricingclasses import *
from TokenLab.simulationcomponents.supplyclasses import *
from TokenLab.simulationcomponents.addons import AddOn_RandomNoise, AddOn_RandomNoiseProportional
from TokenLab.utils.helpers import *
from matplotlib import pyplot as plt


import numpy as np
import scipy.stats
import time
# Required Libraries and Classes
import numpy as np


#choose scenario from
#STANDARD - no multiple
#PESSIMISTIC - 10% of transactions and reduced volume for first year
#OPTIMISTIC - 10x multiple

SCENARIO = 'STANDARD'

if SCENARIO=='STANDARD':
    FORWARD_MULTIPLE = 1
if SCENARIO == 'PESSIMISTIC':
    FORWARD_MULTIPLE = 0.1  
if SCENARIO == 'OPTIMISTIC':
    FORWARD_MULTIPLE=10
    
#choose either EOE or the UCL model
PRICE_MODEL_EOE = False


# Assuming all necessary classes and functions have been imported

INITIAL_PRICE = 0.04
#This is supply at launch
#SUPPLY = 107_000_000
SUPPLY = 210_000_000
ITERATIONS = 46
LEFT = 75
RIGHT = 225
#Given that we are modelling transactions directly, we can ignore the number of users
INITIAL_USERS = 1
MAX_USERS = 1  

MIN_HOLDING_TIME = 12



#Function use to interpolate quarterly data between months
def interpolate_monthly(quarterly_data):
    monthly_data = []
    
    for i in range(len(quarterly_data) - 1):
        difference = quarterly_data[i+1] - quarterly_data[i]
        monthly_increment = difference / 3
        
        # Add the monthly interpolated values
        monthly_data.append(quarterly_data[i])
        monthly_data.append(quarterly_data[i] + monthly_increment)
        monthly_data.append(quarterly_data[i] + 2*monthly_increment)
        
    # Add the last data point from quarterly data
    monthly_data.append(quarterly_data[-1])
    
    return monthly_data

quarterly_data_original = [5350000, 7250000, 9100000, 11000000,    16100000, 24750000, 35100000, 45400000,    55310000, 67900000, 76600000, 85300000, 91100000, 93850000, 94500000, 94500000]
quarterly_data_reduced = [5350000/2, 7250000/2, 9100000/2, 11000000/2, 16100000, 24750000, 35100000, 45400000, 55310000, 67900000, 76600000, 85300000, 91100000, 93850000, 94500000, 94500000]

if SCENARIO=='PESSIMISTIC':
    quarterly_data = quarterly_data_reduced
else:
    quarterly_data = quarterly_data_original

#Forward multiple is applied as a multiple over assumed transactions, which has the effect
#of multiplying the fair value of the token.
monthly_data = interpolate_monthly(np.array(quarterly_data)*FORWARD_MULTIPLE)



# Holding time
#It follows a lognorm distribution. Use plt.hist(holding_time.sample()) to get a histogram
holding_time = HoldingTime_Stochastic(holding_time_params={'loc': MIN_HOLDING_TIME, 's': 1.0})

# User Growth
noise = AddOn_RandomNoiseProportional()
user_growth = UserGrowth_Spaced(initial_users=INITIAL_USERS, max_users=MAX_USERS, num_steps=ITERATIONS, noise_addons=[noise])

# Transaction Controller
tc =  TransactionManagement_Assumptions(monthly_data,noise_addons=[AddOn_RandomNoiseProportional()])


# Agent Pool for fiat users
ap_fiat = AgentPool_Basic(transactions_controller=tc, users_controller=user_growth)

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

# Token Economy
if PRICE_MODEL_EOE:
    price_function = PriceFunction_EOE
else:
    price_function=PriceFunction_LinearRegression
te = TokenEconomy_Basic(supply=SUPPLY, initial_price=INITIAL_PRICE, 
                        holding_time=holding_time,
                        price_function=price_function
                        )
te.add_supply_pools(token_pools)
te.add_agent_pools([ap_fiat])

# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=100)

# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
token_price_timeseries = meta.get_timeseries('token_price')