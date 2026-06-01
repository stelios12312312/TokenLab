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


data_str = "£ 162,635 	 £ 310,368 	 £ 501,761 	 £ 608,852 	 £ 731,282 	 £ 867,098 	 £ 1,014,395 	 £ 1,170,542 	 £ 1,332,421 	 £ 1,496,710 	 £ 1,660,170 	 £ 1,819,878 	 £ 1,973,388 	 £ 2,118,808 	 £ 2,254,810 	 £ 2,380,585 	 £ 2,495,774 	 £ 2,600,383 	 £ 2,694,693 	 £ 2,779,186 	 £ 2,854,476 	 £ 2,921,255 	 £ 2,980,249 	 £ 3,032,186 	 £ 3,077,777 	 £ 3,117,695 	 £ 3,152,571 	 £ 3,182,983 	 £ 3,209,462 	 £ 3,232,483 	 £ 3,252,474 	 £ 3,269,817 	 £ 3,284,848 	 £ 3,297,867 	 £ 3,309,134 	 £ 3,318,881 	 £ 3,327,308 	 £ 3,334,591 	 £ 3,340,884 	 £ 3,346,318 	 £ 3,351,010 	 £ 3,355,060 	 £ 3,358,556 	 £ 3,361,573 	 £ 3,364,175 	 £ 3,366,421 	 £ 3,368,357 	 £ 3,370,028 	 £ 3,371,469 	 £ 3,372,711 	 £ 3,373,782 	 £ 3,374,706 	 £ 3,375,503 	 £ 3,376,189 	 £ 3,376,782 	 £ 3,377,292 	 £ 3,377,732 	 £ 3,378,112 	 £ 3,378,439 	 £ 3,378,721 	 £ 3,378,964"

data_list = [int(value.replace("£", "").replace(",", "")) for value in data_str.split(" 	 ")]

print(data_list)


# Parameters for the Simulation
CIRCULATING_SUPPLY = 0.33
ITERATIONS = 36
SUPPLY = 1e8*CIRCULATING_SUPPLY  # Set to 100 MILLION
INITIAL_PRICE = 0.06
MAX_USERS = 5000000  # Set to 5 million
INITIAL_USERS = 1000
FEE=0.07

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
DATA_GAMMA = np.random.gamma(shape_alpha, 1/rate_beta, ITERATIONS).astype(int)*FEE
# plt.hist(DATA_GAMMA)

# Transaction Management for the new agent pool
transactions_gamma = TransactionManagement_Assumptions(DATA_GAMMA)

# Create New Agent Pool using the user growth object and Gamma distribution transactions
ap_gamma_NFT = AgentPool_Basic(users_controller=user_growth3, transactions_controller=transactions_gamma, currency='$')

# Add the new agent pool to the token economy



# Transaction Management Assumptions
transactions = TransactionManagement_Assumptions(DATA)
transactions_new = TransactionManagement_Assumptions(DATA_NEW)
transactions_revenue = TransactionManagement_Assumptions(data_list)



# Stochastic holding time for agents
holding_time = HoldingTime_Stochastic()

# Create Agent Pools using the user growth object
ap_fiat = AgentPool_Basic(users_controller=user_growth, transactions_controller=transactions, currency='$')
ap_fiat_revenue = AgentPool_Basic(users_controller=1, transactions_controller=transactions_revenue, currency='$')

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
# te.add_agent_pools([ap_fiat, ap_fiat_new])
te.add_agent_pool(ap_fiat_revenue)
te.add_agent_pool(ap_gamma_NFT)


# Run the Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=200)

# Extract Simulation Data
reps = meta.get_data()

# Extract Token Price Data
token_price_timeseries = meta.get_timeseries('tokenA_price',multiple=50)


# plt.hist(sample)
# plt.xlabel('Months')
# plt.ylabel('Frequency')


# plt.plot(user_growth._num_users_store)
# plt.xlabel('Months')
# plt.ylabel('Num users')


# plt.hist(DATA)
# plt.ylabel('Frequency')
# plt.xlabel('Average spend per user in tokens')

