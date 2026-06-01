#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed Aug 30 13:25:07 2023

@author: stylianoskampakis
"""

import numpy as np
import scipy
import sys
import os

import pandas as pd

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


# Parameters for the Simulation
ITERATIONS = 36
SUPPLY = 1e9  # Set to 1 billion
INITIAL_PRICE = 0.05
MAX_USERS = 5000000  # Set to 5 million
INITIAL_USERS = 1000

# User Growth with Noise Setup
noise_addon = AddOn_RandomNoiseProportional(mean_param=0, std_param=5)
user_growth = UserGrowth_Spaced(INITIAL_USERS, MAX_USERS, ITERATIONS, noise_addon=noise_addon)
user_growth2 = UserGrowth_Spaced(INITIAL_USERS, MAX_USERS, ITERATIONS, noise_addon=noise_addon)


# Preliminary Data Generation
LEFT = 150 * 0.5  # 50% less than the mode
RIGHT = 150 * 1.5  # 50% more than the mode
DATA = np.random.triangular(left=LEFT, mode=150, right=RIGHT, size=ITERATIONS).astype(int)

# Parameters for the new DATA
MODE_NEW = -1000
LEFT_NEW = MODE_NEW * 1.5  # 50% more than the mode
RIGHT_NEW = MODE_NEW * 0.5  # 50% less than the mode

# Generate the new DATA
DATA_NEW = np.random.triangular(left=LEFT_NEW, mode=MODE_NEW, right=RIGHT_NEW, size=ITERATIONS).astype(int)

# Parameters for New Agent Pool
PERCENTAGE_OF_USERS = 0.10
user_growth3 = UserGrowth_Spaced(int(INITIAL_USERS * PERCENTAGE_OF_USERS), int(MAX_USERS * PERCENTAGE_OF_USERS), ITERATIONS, noise_addon=noise_addon)

# Generate Transaction Data Using Gamma Distribution
shape_alpha = 2000
rate_beta = 1
DATA_GAMMA = np.random.gamma(shape_alpha, 1/rate_beta, ITERATIONS).astype(int)
# plt.hist(DATA_GAMMA)

# Transaction Management for the new agent pool
transactions_gamma = TransactionManagement_Assumptions(DATA_GAMMA)

# Create New Agent Pool using the user growth object and Gamma distribution transactions
ap_gamma = AgentPool_Basic(users_controller=user_growth3, transactions_controller=transactions_gamma, currency='$')

# Add the new agent pool to the token economy



# Transaction Management Assumptions
transactions = TransactionManagement_Assumptions(DATA)
transactions_new = TransactionManagement_Assumptions(DATA_NEW)



# Stochastic holding time for agents
holding_time = HoldingTime_Stochastic()

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$')

# Create Agent Pools using the user growth object for new agent pool
ap_fiat_new = AgentPool_Basic(users_controller=user_growth2, transactions_controller=transactions_new, currency='tokenA')

# Initialize the Token Economy
te = TokenEconomy_Basic(
    holding_time=holding_time, 
    supply=SUPPLY, 
    token='tokenA', 
    initial_price=INITIAL_PRICE,
                            price_function=PriceFunction_LinearRegression, burn_token=False
)

# Add the agent pool to the token economy
te.add_agent_pools([ap_fiat, ap_fiat_new])
te.add_agent_pool(ap_gamma)


# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=100)

# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
token_price_timeseries = meta.get_timeseries('tokenA_price')


# plt.hist(sample)
# plt.xlabel('Months')
# plt.ylabel('Frequency')


# plt.plot(user_growth._num_users_store)
# plt.xlabel('Months')
# plt.ylabel('Num users')


# plt.hist(DATA)
# plt.ylabel('Frequency')
# plt.xlabel('Average spend per user in $')