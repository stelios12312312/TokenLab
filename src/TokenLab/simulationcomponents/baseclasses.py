#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:17:07 2022

@author: stylianoskampakis
"""
from typing import List, Dict, Union
import numpy as np
import pandas as pd


class AddOn:
    """
    Class which is used within controllers to affect certain internal parameters (e.g. noise)
    """

    def __init__(self):

        pass

    def apply(self) -> float:

        pass


class Initialisable:
    """
    A base class providing initialisation tracking functionality.
    """

    def __init__(self):
        """
        Initialises the Initialisable class.

        The `initialised` attribute is set to False to indicate that
        the object has not been initialised.
        """
        self.initialised = False

    def initialise(self):
        """
        Marks the object as initialised by setting the `initialised` attribute to True.

        If the object is already initialised, this method will have no effect.
        """
        if not self.initialised:
            self.initialised = True
        else:
            print("Warning: The object is already initialised.")


class Controller:
    """
    Base class for all sub-components of a simulation within a token economy.
    """

    def __init__(self, name: str = None):
        """
        Initializes the Controller class.

        Parameters:
        - name: Optional name for the controller instance.
        """
        self.name = name  # The name of the controller instance
        self.iteration = 0  # Current iteration count for the controller
        self.max_iteration = None  # Maximum iterations allowed, if applicable
        self.dependencies = {}  # Dictionary to hold dependencies on other components

    def link(self, dependency_parent: type, dependency_instance) -> bool:
        """
        Links a dependency instance to this controller.

        Parameters:
        - dependency_parent: The expected type of the dependency.
        - dependency_instance: The instance to link as a dependency.

        Returns:
        - True if the link was successful.

        Raises:
        - Exception if the dependency_instance is not of the expected type.
        """
        if isinstance(dependency_instance, dependency_parent):
            self.dependencies[dependency_parent] = dependency_instance
        else:
            raise Exception("Tried to link incompatible type.")

        return True

    def test_integrity(self) -> bool:
        """
        Tests whether all dependencies have a linked object.

        Returns:
        - True if at least one dependency is linked; otherwise, False.
        """
        nones = sum(
            1 for dependency in self.dependencies.values() if dependency is None
        )
        return nones != len(self.dependencies)

    def get_dependencies(self) -> dict:
        """
        Prints and returns the names of all linked dependencies.

        Returns:
        - A dictionary of dependencies.
        """
        print("Dependencies names are: ")
        for dependency in self.dependencies.values():
            name = dependency.name if dependency else "None"
            print(name)

        return self.dependencies

    def __getitem__(self, item):
        """
        Allows access to controller attributes using dictionary-like syntax.

        Parameters:
        - item: The attribute name as a string.

        Returns:
        - The value of the requested attribute.
        """
        return getattr(self, item)


class AgentPool(Controller):
    """
    AgentPool class for managing a pool of users and their transactions.
    Inherits from the Controller class.
    """

    def __init__(self):
        """
        Initializes the AgentPool with default values.
        """
        # Core attributes
        self.num_users = 0  # Number of users in the pool
        self.transactions = 0  # Value of transactions
        self.iteration = 0  # Iteration counter for the pool

        # Optional attributes
        self.currency = None  # The currency used in the pool
        self.name = None  # The name of the agent pool

        # Dependencies
        self.dependencies = {TokenEconomy: None}  # Dependencies on the TokenEconomy

        # Mechanism for generating new pools during execution
        # The format for new pools should be: [('AgentPool', object), ('SupplyPool', object)]
        self.new_pools = []

    def __str__(self) -> str:
        """
        Returns a string representation of the AgentPool, showing the number of users and transaction value.
        """
        users = self.num_users
        trans = (
            self.transactions
        )  # Assuming `self.transactions_controller` is meant to be `self.transactions`

        return f"Users: {users}\nTransactions: {trans}"

    def report(self) -> Dict:
        """
        Generates a report of the current iteration's user and transaction data.

        Returns:
        A dictionary with the number of users and transaction value.
        """
        report = {
            "users": self.num_users,
            "transactions": self.transactions,  # Assuming this is the intended value
        }

        return report

    def get_transactions(self) -> float:
        """
        Returns the value of transactions.

        Returns:
        The value of transactions as a float.
        """
        return self.transactions

    def get_num_users(self) -> int:
        """
        Returns the current number of users in the pool.

        Returns:
        The number of users as an integer.
        """
        return self.num_users

    def reset(self) -> None:
        """
        Resets the iteration counter to zero.
        """
        self.iteration = 0

    def execute(self) -> list:
        """
        Executes the agent pool's operations, potentially generating new pools.

        Returns:
        A list of new pools generated during the execution.
        """
        return self.new_pools


class TokenEconomy:
    """
    Base class for simulating a token economy system.
    """

    def __init__(
        self,
        holding_time: Union[float, Controller],
        supply: Union[float, Controller],
        fiat: str,
        token: str,
        unit_of_time: str,
        price_function: Controller,
        token_initial_price: List[float],
        adapt_supply_to_token_sales: bool = False,
        name: str = None,
    ) -> None:
        """
        Initialize the TokenEconomy class.

        Parameters:
        - holding_time: The average holding time (float or Controller) in the unit of time.
        - supply: The initial supply of tokens (float or Controller).
        - fiat: The fiat currency used in the economy (e.g., '$').
        - token: The token symbol used in the economy.
        - unit_of_time: The unit of time for the simulation (e.g., 'day', 'month').
        - price_function: The function or controller used to simulate the token price.
        - token_initial_price: A list of initial prices for the token, denominated in fiat currency.
        - adapt_supply_to_token_sales: A boolean indicating if the supply should adapt to token sales.
        - name: An optional name for the simulation.
        """
        # Basic economy properties
        self.fiat = fiat  # The fiat currency used in the economy
        self.token = token  # The token symbol used in the economy
        self.unit_of_time = unit_of_time  # The unit of time for the simulation
        self.name = name  # The name of the simulation instance

        # Supply and holding time
        self._holding_time_controller = holding_time  # Controller for holding time
        self._supply = supply  # Controller for token supply
        self.adapt_supply_to_token_sales = (
            adapt_supply_to_token_sales  # Flag to adapt supply to sales
        )

        # Price and transaction properties
        self._price_function = price_function  # Function to calculate token price
        self.price = token_initial_price  # Initial price of the token in fiat
        self.prices = {}  # Dictionary to store token prices over time
        self.transactions_volume_in_tokens = 0  # Total volume of transactions in tokens
        self.transactions_value_in_fiat = 0  # Total value of transactions in fiat

        # Storage for simulation data
        self._supply_pools = []  # List to store supply pools data
        self._supply_store = []  # List to store historical supply data
        self._agent_pools = []  # List to store agent pools (users/entities)
        self._num_users_store = []  # List to store the number of users over time
        self.num_users = 0  # Current number of users in the simulation

        self._transactions_value_store_in_fiat = (
            []
        )  # List to store transaction values in fiat
        self._transactions_value_store_in_tokens = (
            []
        )  # List to store transaction values in tokens
        self._prices_store = []  # List to store historical prices
        self.iteration = 0  # Iteration counter for the simulation

        # Holding time data
        self.holding_time = None  # Current holding time
        self._holding_time_store = []  # List to store holding time history
        self._effective_holding_time_store = (
            []
        )  # List to store effective holding time data

        # Treasury and transaction count data
        self._treasury_store = []  # List to store treasury data
        self._num_transactions_store = (
            []
        )  # List to store the number of transactions over time

    def execute(self):
        """
        Placeholder method to execute a simulation step.
        """
        pass

    def get_state(self) -> Dict[str, Union[float, int]]:
        """
        Get the current state of the economy.

        Returns:
        A dictionary containing key statistics of the economy.
        """
        state = {
            "transactions_" + self.fiat: self.transactions_value_in_fiat,
            "supply": self._supply,
            "holding_time": self.holding_time,
            "num_users": self.num_users,
        }
        state["transactions_" + self.token] = self.transactions_volume_in_tokens
        state[self.token + "_price"] = self.price

        return state

    def __getitem__(self, item):
        """
        Allows access to class attributes using dictionary-like syntax.

        Parameters:
        - item: The attribute name as a string.

        Returns:
        The value of the requested attribute.
        """
        return getattr(self, item)
