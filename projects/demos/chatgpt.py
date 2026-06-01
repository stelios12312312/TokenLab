#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Aug 22 20:47:32 2023

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
from TokenLab.simulationcomponents.addons import AddOn_RandomNoise, AddOn_RandomNoiseProportional
from TokenLab.utils.helpers import *
from matplotlib import pyplot as plt
import numpy as np

# Preliminary Definitions
import numpy as np

# Preliminary Definitions
data = np.random.randint(size=30, low=100, high=1000000)

# Generate sinusoidal data between 1000 and 3000
x = np.linspace(0, 2 * np.pi, 30)  # 30 data points between 0 and 2π
sinusoidal_data_raw = 1000 + ((np.sin(x) + 1) / 2) * (3000 - 1000)  # Scale sine wave to be between 1000 and 3000

# Process data with TransactionManagement_Assumptions
transactions = TransactionManagement_Assumptions(data)
sinusoidal_transactions = TransactionManagement_Assumptions(sinusoidal_data_raw)

SUPPLY = 10**8
INITIAL_PRICE = 0.1
ITERATIONS = 30
holding_time = HoldingTime_Stochastic()

# Token Economy Setup for first agent pool
ap_fiat = AgentPool_Basic(users_controller=1, transactions_controller=transactions, currency='$')

# Token Economy Setup for second agent pool with sinusoidal data
ap_sinusoidal = AgentPool_Basic(users_controller=1, transactions_controller=sinusoidal_transactions, currency='$')

te = TokenEconomy_Basic(
    holding_time=holding_time, 
    supply=SUPPLY, 
    token='tokenA', 
    initial_price=INITIAL_PRICE, 
    burn_token=True
)

# Adding both agent pools to the token economy
te.add_agent_pools([ap_fiat, ap_sinusoidal])

# Simulation
meta = TokenMetaSimulator(te)
meta.execute(iterations=ITERATIONS, repetitions=100)
reps = meta.get_data()

# Extract Token Price Data
token_price_timeseries = meta.get_timeseries('tokenA_price')

