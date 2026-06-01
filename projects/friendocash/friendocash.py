#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TokenLab Simulation with Updated Supply Schedule and TGE Handling.

Author: [Your Name]
"""

import numpy as np
import scipy.stats
import sys
import os
import pandas as pd
from matplotlib import pyplot as plt

# Attempt to import TokenLab; adjust the path if necessary
try:
    import TokenLab
except ImportError:
    tokenlab_path = os.path.abspath("").replace('projects', 'src')
    sys.path.insert(0, tokenlab_path)
    import TokenLab

from TokenLab.simulationcomponents import *
from TokenLab.simulationcomponents.usergrowthclasses import *
from TokenLab.simulationcomponents.transactionclasses import *
from TokenLab.simulationcomponents.tokeneconomyclasses import *
from TokenLab.simulationcomponents.agentpoolclasses import *
from TokenLab.simulationcomponents.pricingclasses import *
from TokenLab.simulationcomponents.supplyclasses import *
from TokenLab.simulationcomponents.addons import *
from TokenLab.utils.helpers import *
import math

# ----------------------------
# Token Distribution Schedule
# ----------------------------

# Define the path to your local CSV file
csv_file_path = 'friendocash.csv'  # Replace with the actual path if different

# Read the required columns, including 'TGE (0)'
try:
    token_schedule_df = pd.read_csv(
        csv_file_path,
        usecols=['Pool', '$FRIENDO Amount', 'Vesting', 'TGE (0)'],
        skipinitialspace=True
    )
    print("CSV file loaded successfully.")
except FileNotFoundError:
    print(f"Error: The file '{csv_file_path}' was not found.")
    sys.exit(1)
except pd.errors.ParserError as e:
    print(f"ParserError: {e}")
    sys.exit(1)

# Function to clean numeric fields by removing non-standard spaces and commas
def clean_numeric_fields(df):
    numeric_columns = ['$FRIENDO Amount', 'Vesting', 'TGE (0)']  # Include 'TGE (0)'
    for col in numeric_columns:
        # Remove non-breaking spaces (\xa0) and regular spaces, and replace commas
        df[col] = df[col].astype(str).str.replace('\xa0', '').str.replace(' ', '').str.replace(',', '')
        # Replace empty strings with '0'
        df[col] = df[col].replace('', '0')
        # Convert to numeric, coercing errors to NaN, then fill NaN with 0 and convert to int
        df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0).astype(int)
    return df

# Clean the numeric fields
token_schedule_df = clean_numeric_fields(token_schedule_df)

# Display the schedule (optional)
print("Token Distribution Schedule:")
print(token_schedule_df.head())

# ----------------------------
# Simulation Parameters
# ----------------------------

ITERATIONS = 48  # Ensure this covers the longest vesting period
REPETITIONS = 100  # Number of simulation repetitions
INITIAL_PRICE = 0.0050  # Launch price of the token in USD
SUPPLY = token_schedule_df['$FRIENDO Amount'].sum()  # Total supply based on the schedule

print(f"Total Supply: {SUPPLY}")

# ----------------------------
# Helper Functions
# ----------------------------

def create_supply_controllers(schedule_df):
    """
    Creates a list of SupplyControllers based on the token distribution schedule,
    handling TGE amounts and linear vesting over the vesting period.
    """
    supply_controllers = []

    for _, row in schedule_df.iterrows():
        pool_name = row['Pool']
        total_amount = row['$FRIENDO Amount']
        vesting_months = row['Vesting']
        tge_amount = row['TGE (0)']

        # Calculate the remaining amount after TGE
        remaining_amount = total_amount - tge_amount

        if tge_amount > 0:
            # Create a SupplyController_Constant for the TGE amount
            tge_controller = SupplyController_Constant(supply=tge_amount)
            tge_controller.name = f"{pool_name} TGE"
            supply_controllers.append(tge_controller)
            print(f"Created SupplyController_Constant for TGE of pool '{pool_name}' with amount {tge_amount}")

        if vesting_months == 0 or remaining_amount <= 0:
            # No vesting, all tokens are released at TGE or no remaining tokens
            continue
        else:
            # Create a linear release schedule over the vesting period for the remaining tokens
            monthly_release = remaining_amount / vesting_months

            # Create a list of monthly releases
            release_schedule = [monthly_release] * vesting_months

            # Pad the release schedule with zeros to match the total iterations
            if vesting_months < ITERATIONS:
                release_schedule += [0] * (ITERATIONS - vesting_months)

            # Initialize the SupplyController_FromData with the release schedule
            supply_controller = SupplyController_FromData(values=release_schedule)
            supply_controller.name = f"{pool_name} Vesting"
            print(f"Created SupplyController_FromData for pool '{pool_name}' with remaining amount {remaining_amount} over {vesting_months} months")
            supply_controllers.append(supply_controller)

    return supply_controllers

# ----------------------------
# Create Supply Controllers
# ----------------------------

supply_pools = create_supply_controllers(token_schedule_df)

# ----------------------------
# User Growth Configuration
# ----------------------------

# For simplicity, we'll assume a constant number of users.
INITIAL_USERS = 1000

user_growth = UserGrowth_Constant(constant=INITIAL_USERS)

# ----------------------------
# Transaction Management
# ----------------------------

# Define transaction volume (can be customized or made dynamic)
INITIAL_TRANSACTION_VOLUME = 2_000_00  # Starting transaction volume

transactions = TransactionManagement_Constant(
    average_transaction_value=INITIAL_TRANSACTION_VOLUME
)

# ----------------------------
# Holding Time Configuration
# ----------------------------

# Define holding time with a log-normal distribution
MIN_HOLDING_TIME = 24  # Minimum holding time in months

holding_time = HoldingTime_Stochastic(holding_time_params={'loc': MIN_HOLDING_TIME, 's': 1.0})

# ----------------------------
# Agent Pools Configuration
# ----------------------------

# Define Transaction Controller with Assumptions
tc = TransactionManagement_Assumptions(
    data=[INITIAL_TRANSACTION_VOLUME] * ITERATIONS,
    ignore_num_users=True
)

# Define Agent Pool for fiat users
ap_fiat = AgentPool_Basic(
    transactions_controller=tc,
    users_controller=user_growth
)

# ----------------------------
# Token Economy Setup
# ----------------------------

te = TokenEconomy_Basic(
    supply=0,  # Starting with zero supply; supply will be managed by supply controllers
    initial_price=INITIAL_PRICE,
    holding_time=holding_time,
    price_function=PriceFunction_LinearRegression,
    supply_pools=supply_pools,
    agent_pools=[ap_fiat],
    supply_is_added=True, 
    burn_coefficient=0.05,
    multiple=3
)

# ----------------------------
# Simulation Execution
# ----------------------------

# Initialize the simulator
meta = TokenMetaSimulator(te)

# Execute the simulation
print("Starting simulation...")
meta.execute(iterations=ITERATIONS, repetitions=REPETITIONS)
print("Simulation completed.")

# ----------------------------
# Data Extraction and Visualization
# ----------------------------

# Extract simulation data
reps = meta.get_data()

# Extract Token Price Timeseries
_, token_price_timeseries = meta.get_timeseries('token_price')

# Plot Token Price Over Time (Average Across Repetitions)
plt.figure(figsize=(12, 6))
plt.plot(token_price_timeseries['token_price_mean'], label='Average Token Price')
plt.fill_between(
    token_price_timeseries.index,
    token_price_timeseries['quant_10%'],
    token_price_timeseries['quant_90%'],
    color='b',
    alpha=0.2,
    label='80% Confidence Interval'
)
plt.title('Token Price Over Time')
plt.xlabel('Month')
plt.ylabel('Price (USD)')
plt.legend()
plt.grid(True)
plt.show()

# Extract and Plot Token Supply Over Time
_, supply_timeseries = meta.get_timeseries('supply')
plt.figure(figsize=(12, 6))
plt.plot(supply_timeseries['supply_mean'], label='Total Supply')
plt.fill_between(
    supply_timeseries.index,
    supply_timeseries['quant_10%'],
    supply_timeseries['quant_90%'],
    color='g',
    alpha=0.2,
    label='80% Confidence Interval'
)
plt.title('Token Supply Over Time')
plt.xlabel('Month')
plt.ylabel('Supply')
plt.legend()
plt.grid(True)
plt.show()

# Optional: Save the simulation data to CSV
# reps.to_csv('simulation_results.csv', index=False)

print("Data extraction and visualization completed successfully.")
