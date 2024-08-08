#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:18:42 2022

@author: stylianoskampakis
"""

from typing import List, Dict, Union
from baseclasses import *
from TokenLab.utils.helpers import log_saturated_space, logistic_saturated_space
import copy
import scipy
import warnings
import time
from matplotlib import pyplot as plt


class UserGrowth(Controller):
    """
    Base class that models user growth. Dependencies include AgentPool and TokenEconomy.
    """

    def __init__(self):
        super(UserGrowth, self).__init__()
        self.num_users = 0
        self._num_users_store = None

        # conditional dependence, it is used only in conditions
        self.dependencies = {AgentPool: None, TokenEconomy: None}

        return None

    def execute(self) -> int:
        if self._num_users_store is not None:
            # this is only for precomputed user populations, like UserGrowth_Spaced
            self.num_users = self._num_users_store[self.iteration]
        self.iteration = self.iteration + 1

        return self.num_users

    def get_num_users(self) -> int:

        return self.num_users

    def reset(self) -> None:
        """
        Resets the iteration counter to 0.

        """
        self.iteration = 0


class UserGrowth_Spaced(UserGrowth):
    """
    Creates the number of users (for a predetermined number of iterations)
    using a function that is spacing out users between min and max. Options include:

    linearspace, logspace, geomspace, logistic

    The class pre-calculates all users internally and stores them in _num_users_store.

    When executed it simply returns the users at the current iteration of its lifecycle.

    """

    def __init__(
        self,
        initial_users: int,
        max_users: int,
        num_steps: int,
        space_function: Union[
            np.linspace,
            np.logspace,
            np.geomspace,
            log_saturated_space,
            logistic_saturated_space,
        ] = np.linspace,
        name: str = None,
        noise_addons: List[AddOn] = [],
        use_difference: bool = False,
    ) -> None:
        """
        Parameters
        ----------
        initial_users : int
            The initial number of users.
        max_users : int
            The maximum number of users.
        num_steps : int
            The number of iterations the simulation will run for.
        space_function : Union[np.linspace, np.logspace, np.geomspace, log_saturated_space, logistic_saturated_space], optional
            A function that will generate the sequence of user numbers. The default is np.linspace.
        name : str, optional
            The name of this controller. The default is None.
        noise_addons : List[AddOn], optional
            Noise AddOns from the AddOns module. The default is an empty list.
        use_difference : bool, optional
            If True, it will calculate and return the difference between time steps. The default is False.

        Returns
        -------
        None.

        use_difference: If True, it will calculate and return the difference between time steps. Essentially, the user
        base will grow according to the difference between the steps in the sequence.

        Otherwise, it returns the actual value.

        For example:
            initial_users=100
            growth=[100,120,150,200]
            final=[100,120,150,200]

            with difference:
                final=[100,0,20,30,50]
        """
        super(UserGrowth_Spaced, self).__init__()

        self._initial_users = initial_users
        self.max_users = max_users
        self.num_steps = num_steps
        self.space_function = space_function
        self._noise_component = noise_addons
        self.name = name
        self.use_difference = use_difference

        self._num_users_store_original = self._generate_user_store()
        self._num_users_store = self._apply_noise(
            copy.deepcopy(self._num_users_store_original)
        )

        self.max_iterations = num_steps

    def _generate_user_store(self) -> np.ndarray:
        """
        Generates the user store sequence using the space function.
        """
        user_store = np.round(
            self.space_function(
                start=self._initial_users, stop=self.max_users, num=self.num_steps
            )
        ).astype(int)

        if self.use_difference:
            user_store = [self._initial_users] + np.diff(user_store).tolist()

        return user_store

    def _apply_noise(self, user_store: np.ndarray) -> np.ndarray:
        """
        Applies noise to the user store if noise component is present.
        """
        if not self._noise_component:
            return user_store

        noisy_store = []
        for value in user_store:
            for noiser in self._noise_component:
                value = noiser.apply(value=value)
            noisy_store.append(max(value, 0))  # Ensure no negative values

        return np.array(noisy_store)

    def reset(self) -> None:
        """
        Recalculates the noise component and sets the user counter back to 0.
        """
        self._num_users_store = self._apply_noise(
            copy.deepcopy(self._num_users_store_original)
        )
        self.iteration = 0
        self.num_users = self._initial_users

    def get_users_store(self) -> List:
        """
        Returns the list that contains the pre-calculated number of users. This is a
        private variable.

        """

        return self._num_users_store

    def get_data(self) -> List:
        """
        Used for compatibility reasons
        """

        return self.get_users_store()

    def plot_users(self):

        plt.plot(self.get_users_store())
        plt.xlabel("unit of time")
        plt.ylabel("users")


class UserGrowth_Constant(UserGrowth):
    """
    Simplest type of usergrowth class. The user growth simply stays constant.
    """

    def __init__(self, constant: int):
        """

        Parameters
        ----------
        constant : int
            The total number of users.

        """

        super(UserGrowth_Constant, self).__init__()
        self.num_users = constant


class UserGrowth_FromData(UserGrowth):

    def __init__(self, data: int):

        super(UserGrowth_FromData, self).__init__()

        self._num_users_store = np.ndarray.flatten(np.array(data))


class UserGrowth_Stochastic(UserGrowth):
    """
    UserGrowth that simply samples a random value during each iteration.

    """

    def __init__(
        self,
        user_growth_distribution: scipy.stats = scipy.stats.poisson,
        user_growth_dist_parameters: Union[List, Dict] = [{"mu": 1000}],
        add_to_userbase: bool = False,
        num_initial_users: int = 0,
        noise_addons: List[AddOn] = [],
    ):
        """


        Parameters
        ----------
        user_growth_distribution : scipy.stats, optional
            The distribution to sample values from. The default is scipy.stats.poisson.

        user_growth_dist_parameters : Union[List,Dict], optional
            Either a list of dictionaries, or a dictionary. If a list is provided
            then the parameters change at every iteration. The default is [{'mu':1000}].

        add_to_user_base : bool, optional
        If False, then the actual number of users is sampled from the distribution. If True,
        then this number of users is added to the total number of users. Default is false.

        num_initial_users : int, optional
        The number of initial users. Default is 0
        """

        super(UserGrowth_Stochastic, self).__init__()

        self.user_growth_distribution = user_growth_distribution
        self.user_growth_dist_parameters = user_growth_dist_parameters
        self.num_users = num_initial_users
        self.add_to_userbase = add_to_userbase
        self._noise_component = noise_addons
        return None

    def execute(self):
        seed = int(int(time.time()) * np.random.rand())
        if type(self.user_growth_dist_parameters) == list:
            try:
                params = self.user_growth_dist_parameters[self.iteration]
            except:
                warnings.warn(
                    "Iterations for UserGrowth stochastic exhausted. Simply using the last item on the list of parameters."
                )
                params = self.user_growth_dist_parameters[-1]
        else:
            params = self.user_growth_dist_parameters

        self._active_params = params
        value = self.user_growth_distribution.rvs(size=1, random_state=seed, **params)[
            0
        ]

        if self.add_to_userbase:
            self.num_users += value
        else:
            self.num_users = value

        # apply noise components (if any)
        if self._noise_component != None:
            value = self.num_users
            for noiser in self._noise_component:
                value = noiser.apply(**{"value": value})

            self.num_users = value

        self.iteration += 1
        return self.num_users
