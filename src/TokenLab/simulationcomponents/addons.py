#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed Nov 30 10:34:43 2022

@author: stylianoskampakis
"""
import numpy as np
from baseclasses import *
import scipy
from scipy.stats import binom, norm
import time
import warnings
from typing import Callable
from abc import ABC, abstractmethod


class AddOn_Noise(AddOn, ABC):
    """
    Abstract class for add-on classes that are used to induce noise.
    """

    def __init__(self, add_value: bool = True):
        super().__init__()
        self.add_value = add_value

    @abstractmethod
    def apply(self, **kwargs) -> float:
        """
        Abstract method. Each AddOn_Noise class needs to have an apply function.
        """
        pass

    def reset(self):

        self.iteration = 0


class AddOn_RandomNoise(AddOn_Noise):
    """
    Adds random noise (normaly gaussian) to a parameter
    """

    def __init__(
        self,
        noise_dist: scipy.stats = scipy.stats.norm,
        dist_params: Dict = {"loc": 0, "scale": 1},
        add_value: bool = True,
    ) -> None:
        """
        Parameters
        ----------
        noise_dist: A scipy.stats distribution (by default normal)
        dist_params: The distribution parameters in the format {'loc':float,'scale':float}
        """

        self.noise_dist = noise_dist
        self.dist_params = dist_params
        self.add_value = add_value

    # need to use **kwargs for compatibility with other classes that take input
    # like AddOn_RandomNoiseProportional
    def apply(self, **kwargs) -> float:
        """

        Parameters
        ----------
        **kwargs : this used for compatibility reasons, **kwargs is not applied at all in this particular.
        instance unless 'value' is provided

        Returns
        -------
        float
            noise.

        """

        value = kwargs.get("value", 0)

        seed = int(int(time.time()) * np.random.rand())
        noise = self.noise_dist.rvs(size=1, **self.dist_params, random_state=seed)[0]
        if self.add_value:
            final = value + noise

        return final


class AddOn_RandomNoiseProportional(AddOn_Noise):
    """
    Adds random noise (normaly gaussian) to a parameter. The scale is dependent on the actual input value.
    So, if we use gaussian, the std becomes value/std_param. So, if we apply this on price for example,
    the more the price increases in size, the more volatility is induced.
    """

    def __init__(
        self,
        noise_dist: scipy.stats = scipy.stats.norm,
        mean_param=0,
        std_param=5,
        add_value: bool = True,
    ) -> None:
        """

        Parameters
        ----------
        noise_dist: A scipy.stats distribution (by default normal)
        mean_param: The mean of the distribution. This is added to the provided value at execution.
        For example, if modelling user growth, the current number of users is added to this number

        std_param: The effective std of the distribution becomes value/std_param, where
        value is externally provided in the apply function.

        """

        self.noise_dist = noise_dist
        self.mean_param = mean_param
        self.std_param = std_param
        self.add_value = add_value

    def apply(self, value) -> float:
        seed = int(int(time.time()) * np.random.rand())
        noise = self.noise_dist.rvs(
            size=1,
            loc=self.mean_param + value,
            scale=value / self.std_param,
            random_state=seed,
        )[0]

        if self.add_value:
            final = value + noise
        else:
            final = noise

        return final


class AddOn_RandomReduction(AddOn_Noise):
    """
    Reduces a parameter by a random percentage. The percentage is generated from a specified
    probability distribution within the range [0, 1].

    This class can be used to simulate things like the % of active users by using it inside a
    users growth class.
    """

    def __init__(
        self,
        reduction_dist: scipy.stats.rv_continuous = scipy.stats.uniform(loc=0, scale=1),
    ) -> None:
        """
        Parameters
        ----------
        reduction_dist: A scipy.stats distribution for the reduction percentage
                        (by default uniform distribution between 0 and 1).
        """
        super().__init__()
        self.reduction_dist = reduction_dist

    def apply(self, value) -> float:
        """
        Applies a random reduction to the given value.

        Parameters
        ----------
        value: The value to be reduced.

        Returns
        -------
        float
            The value after applying the random reduction.
        """
        # Generate a random reduction percentage
        seed = int(time.time() * np.random.rand())
        reduction_percentage = self.reduction_dist.rvs(random_state=seed)

        # Calculate the reduced value
        reduced_value = value * (1 - reduction_percentage)

        return reduced_value


class AddOn_MultiplierTimed(AddOn_Noise):
    """
    This class is used to supress or increase numbers for a predefined number of iterations
    """

    def __init__(self, multiplier: float = 1, iterations: List = [0, 1]):
        """


        Parameters
        ----------
        multiplier : float, optional
            The value provided is multiplied by multiplier. The default is 1.
        iterations : List, optional
            The rule is applied only within the bounds [start_iteration,end_iteration]. The default is [0,1].

        Returns
        -------
        None.

        """
        self.multiplier = multiplier
        self.iterations = iterations
        self.iteration = 0

    def apply(self, value) -> float:
        if (
            self.iteration >= self.iterations[0]
            and self.iteration <= self.iterations[1]
        ):
            new_value = value * self.multiplier
        else:
            new_value = value

        self.iteration += 1
        return new_value


class Condition:
    """
    A class to evaluate a condition based on variables from a simulation component.

    Example usage:
        usm_fiat = UserGrowth_Spaced(100, 54000, ITERATIONS, log_saturated_space)
        ap_fiat = AgentPool_Basic(users_controller=usm_fiat, transactions_controller=100, currency='$')
        condition = Condition(ap_fiat, ['transactions'], lambda x: x[0] > 1000)
        result = condition.execute()
    """

    def __init__(
        self,
        variables: List[str],
        condition: Callable,
        sim_component: Union[TokenEconomy, Controller] = None,
    ):
        """
        Initializes the Condition class.

        Parameters:
        ----------
        sim_component : Union[TokenEconomy, Controller]
            The simulation component from which the variables will be read.
            This must be either a TokenEconomy or a Controller object (e.g., UserGrowth or TransactionManagement).

        variables : List[str]
            A list of variable names that the condition needs to access.

        condition : Callable[[List], bool]
            A lambda expression or function that takes a list of variables and returns a Boolean.
            The condition should access the variables via list indexing (e.g., lambda x: x[0] > 1000).
        """
        self.sim_component = sim_component
        self.variables = variables
        self.condition = condition
        self.result = None

    def execute(self) -> bool:
        """
        Executes the condition based on the current values of the specified variables.

        Returns:
        -------
        res : bool
            True if the condition is met, False otherwise.
        """
        # Gather the current values of the specified variables from the simulation component
        var_list = [self.sim_component[vari] for vari in self.variables]

        # Evaluate the condition with the collected variables
        self.result = self.condition(var_list)

        return self.result

    def get_result(self) -> Union[bool, None]:
        """
        Returns the most recent result of the condition check.

        Returns:
        -------
        result : bool or None
            The result of the most recent condition evaluation, or None if it hasn't been executed yet.
        """
        if self.result is None:
            warnings.warn("Condition has not been executed yet. Returning None.")
        return self.result
