#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:19:09 2022

@author: stylianoskampakis
"""
from baseclasses import *
from typing import List, Dict, Union
from usergrowthclasses import UserGrowth
import scipy
from scipy.stats import binom, norm, poisson
import numpy as np
from TokenLab.utils.helpers import log_saturated_space, logistic_saturated_space
import copy
import time
from matplotlib import pyplot as plt


class TransactionManagement(Controller):
    """
    Abstract class.

    Models transactions for individual agents, by modelling them as an aggregate.

    It requires the total number of users conducting those transactions.

    """

    def __init__(self, ignore_num_users: bool = False):
        super(TransactionManagement, self).__init__()
        self.dependencies = {AgentPool: None, TokenEconomy: None}
        self.transactions_value = None
        # keeps a record of transactions across all iterations
        self._transactions_value_store = []
        self._ignore_num_users = ignore_num_users
        self.num_transactions = 1

    def execute(self, dependency: str = "AgentPool"):
        """


        Parameters
        ----------
        dependency: The execute function of TransactionsManagement requires the user to define the
        dependency. Usually this is either AgentPool or TokenEconomy.

        This is where the number of users will be acquired from, when calculating the total transaction value.

        Returns
        -------
        None.

        """

        return None

    def reset(self) -> None:
        """
        Sets the iteration counter to 0.

        """

        self.iteration = 0
        pass

    def get_transactions(self) -> List:

        return self.transactions_value

    def get_num_transactions(self) -> int:

        return self.num_transactions

    def plot(self):

        plt.plot(self._transactions_value_store)


class TransactionManagement_Constant(TransactionManagement):
    """
    TransactionManagement implementation where the total value per user stays the same.
    """

    def __init__(self, average_transaction_value: float, noise_addons: [AddOn] = None):

        super(TransactionManagement_Constant, self).__init__()

        # if average_transaction_value<0:
        #    raise Exception('Average transaction value cannot be negative')

        self.average_transaction_value = average_transaction_value
        self._noise_component = noise_addons

    def execute(self, dependency: str = "AgentPool") -> float:
        """

        Parameters
        ----------
        dependency:str: Available options are either AgentPool or TokenEconomy.

        The execute function of TransactionsManagement requires the user to define the
        dependency. Usually this is either AgentPool or TokenEconomy.

        This is where the number of users will be acquired from, when calculating the total transaction value.

        Final transaction value is simply num_users*constant (defined at class initialisation)

        """

        if dependency == "AgentPool":
            dependency = AgentPool
        elif dependency == "TokenEconomy":
            dependency = TokenEconomy
        else:
            raise Exception("You must use either AgentPool or TokenEconomy")

        num_users = self.dependencies[dependency]["num_users"]
        self.total_users = num_users

        self.transactions_value = num_users * self.average_transaction_value

        if self._noise_component is not None:
            for noiser in self._noise_component:
                self.transactions_value = noiser.apply(value=self.transactions_value)

        self._transactions_value_store.append(self.transactions_value)
        self.iteration += 1
        return self.transactions_value


class TransactionManagement_FromData(TransactionManagement):
    """
    Class that simply provides transactions based on a pre-defined assumptions.

    Does not use any dependencies.

    The difference with TransactionManagement_Assumptions is that this class completely ignores
    the number of users.
    """

    def __init__(self, data: List, repeat_last=True):
        """


        Parameters
        ----------
        data : List
            The supply schedule, one datapoint per unit of time.
        repeat_last : TYPE, optional
            If true, then keep emitting the last datapoint in case the list runs out. The default is True.

        Returns
        -------
        None.

        """
        super(TransactionManagement_FromData, self).__init__()

        self.data = np.ndarray.flatten(np.array(data))
        self.repeat_last = repeat_last

    def execute(self) -> float:
        if self.iteration < len(self.data):
            res = self.data[self.iteration]
        else:
            if self.repeat_last:
                return self.data[-1]
            else:
                raise Exception("TransactionManagement_FromData ran out of data!")

        self.transactions_value = res
        self.iteration += 1

        return res


class TransactionManagement_Channeled(TransactionManagement):
    """
    Class that channels a % of the tokens from a token economy, to another.

    This is meant to be used in situations where there are multiple token economies.

    """

    def __init__(
        self,
        dependency_token_economy,
        fiat_or_token: str,
        percentage: float,
        noise_addons: [AddOn] = None,
    ):
        """


        Parameters
        ----------
        dependency_tokeneconomy : TYPE
            The token economy where the tokens will be read from.
        fiat_or_token : str
            Must be either 'fiat' or 'token'.

        percentage : float
            The percentage of tokens channeled to the dependent economy.

        Returns
        -------
        None.

        """
        super(TransactionManagement_Channeled, self).__init__()

        self._dependency_token_economy = dependency_token_economy
        self._fiat_or_token = fiat_or_token
        self._percentage = percentage
        self._noise_component = noise_addons

    def execute(self) -> float:
        # Validate the fiat_or_token value
        if self._fiat_or_token not in ["fiat", "token"]:
            raise Exception(
                "When using a channeled transactions manager you need to define Fiat or Token!"
            )

        # Calculate the value based on the type (fiat or token)
        value = self._percentage * (
            self._dependency_token_economy.transactions_value_in_fiat
            if self._fiat_or_token == "fiat"
            else self._dependency_token_economy.transactions_volume_in_tokens
        )

        # Apply noise components if any
        if self._noise_component:
            for noiser in self._noise_component:
                value = noiser.apply(value=value)

        # Update state and return the value
        self.transactions_value = value
        self.iteration += 1

        return value


class TransactionManagement_Assumptions(TransactionManagement):
    """
    Class that simply provides transactions based on a pre-defined assumptions.

    By default, it reads the number of users and then computes the total transactions as
    num_users*transactions. If ignore_num_users=True, then it ignores the num of users, and it is equivalent
    to TransactionsManagement_FromData

    """

    def __init__(
        self, data: List, noise_addons: [AddOn] = None, ignore_num_users: bool = False
    ):

        self.dependencies = {AgentPool: None}

        super(TransactionManagement_Assumptions, self).__init__()

        self.data = np.ndarray.flatten(np.array(data))

        self._noise_component = noise_addons

        self._ignore_num_users = ignore_num_users

        if self._noise_component is not None:
            dummy = []
            for i in range(len(self.data)):
                temporary = self.data[i]
                for noiser in self._noise_component:
                    temporary = noiser.apply(value=temporary)

                if temporary >= 0:
                    dummy.append(temporary)
                else:
                    dummy.append(self.data_transactions_means_store_original[i])

            self.data = dummy

    def execute(self, dependency: str = "AgentPool") -> float:
        # Validate dependency
        if dependency == "AgentPool":
            dependency = AgentPool
        elif dependency == "TokenEconomy":
            dependency = TokenEconomy
        else:
            raise Exception("You must use either AgentPool or TokenEconomy")

        # Get the number of users if not ignored
        num_users = (
            1 if self._ignore_num_users else self.dependencies[dependency]["num_users"]
        )

        # Calculate the transaction value
        value = self.data[self.iteration] * num_users

        # Update the state
        self.transactions_value = value
        self.iteration += 1

        return value


class TransactionManagement_Trend(TransactionManagement):
    """
    Creates a trend of transactions (increasing or decreasing), while also accepting noise add-ons.

    It has a dependency on a UserGrowth class. To be used inside an agent pool. At execution it can read
    either from the agent class or the token economy.

    So, it essentially functions like a constant tranction class, where the constant is either rising or
    going down in a smooth way.


    Properties of interest:

    _transactions_means_store: The average transaction size for a given iteration
    _transactions_value_store: The actual value of the transaction

    """

    def __init__(
        self,
        average_transaction_initial: float,
        average_transaction_final: float,
        num_steps: int,
        space_function: Union[
            np.linspace,
            np.logspace,
            np.geomspace,
            log_saturated_space,
            logistic_saturated_space,
        ] = np.linspace,
        name: str = None,
        noise_addons: [AddOn] = None,
    ):
        """


        Parameters
        ----------
        average_transaction_initial : float
            The initial transaction size.
        average_transaction_final : float
            The final transaction size.
        num_steps : int
            This should be equal to the number of iterations you want the simulation to run for.
        space_function : Union[np.linspace,np.logspace,np.geomspace,log_saturated_space], optional
            The function that will generate the steps. The default is np.linspace. Other options include np.geomspace
            and log_saturated_space from the helpers module.
        name : str, optional
            The name of this controller. The default is None.
        noise_addon : AddOn, optional
            The default is None.


        """

        super(TransactionManagement_Trend, self).__init__()

        self.dependencies = {AgentPool: None}

        self.num_steps = num_steps
        self.space_function = space_function
        self._noise_component = noise_addons

        self.name = name

        self._transactions_means_store_original = np.round(
            self.space_function(
                start=average_transaction_initial,
                stop=average_transaction_final,
                num=num_steps,
            )
        ).astype(int)
        self._transactions_means_store = copy.deepcopy(
            self._transactions_means_store_original
        )

        # applies the noise addon. If a value is below 0, then it is kept at 0.
        if self._noise_component is not None:
            dummy = []
            for i in range(len(self._transactions_means_store)):
                temporary = self._transactions_means_store_original[i]
                for noiser in self._noise_component:
                    temporary = noiser.apply(value=temporary)

                if temporary >= 0:
                    dummy.append(temporary)
                else:
                    dummy.append(self._transactions_means_store_original[i])

            self._transactions_means_store = dummy

        self.max_iterations = num_steps
        self._transactions_value_store = []

    def execute(self, dependency: str = "AgentPool") -> float:
        """
        Parameters
        ----------
        dependency : str, optional
            Where to read the number of users from. The default is "AgentPool".


        Returns
        -------
        float
            The total value of transactions.
        """
        # Validate the dependency and resolve it to the actual class
        if dependency == "AgentPool":
            dependency = AgentPool
        elif dependency == "TokenEconomy":
            dependency = TokenEconomy
        else:
            raise Exception("You must use either AgentPool or TokenEconomy")

        num_users = self.dependencies[dependency]["num_users"]

        # Calculate the transaction value
        value = num_users * self._transactions_means_store[self.iteration]

        # Apply noise components if any
        if self._noise_component:
            for noise in self._noise_component:
                value = noise.apply(value=value)

        # Update state and return the value
        self.transactions_value = value
        self._transactions_value_store.append(self.transactions_value)
        self.iteration += 1

        return self.transactions_value

    def reset(self) -> bool:
        """
        Sets the iterations counter to 0, and recalculates the effect of any
        noise add-ons.

        Returns
        -------
        True if reset was successful.
        """

        self.iteration = 0
        self._transactions_means_store = copy.deepcopy(
            self._transactions_means_store_original
        )
        if self._noise_component is not None:
            for noise in self._noise_component:
                noise.reset()

        return True

    def plot(self):

        plt.plot(self._transactions_means_store)
        plt.xlabel("iterations")
        plt.ylabel("transactions")


class TransactionManagement_MarketcapStochastic(TransactionManagement):
    """
    This is a special transactions class that models transactions as a percentage of marketcap.

    It is based upon an observation by Dr Stylianos Kampakis that day to day transaction volume difference
    looks a lot like a standard normal distribution multiplied by the total market cap (i.e. a random walk).
    """

    def __init__(
        self,
        distribution=scipy.stats.norm,
        distribution_params={"loc": 0, "scale": 0.25},
        sign="any",
    ):
        super(TransactionManagement_MarketcapStochastic, self).__init__()

        self.dependencies = {AgentPool: None}
        self.distribution = distribution
        self.distribution_params = distribution_params
        self.sign = sign
        self.num_transactions = 1

    def execute(self) -> float:

        tokeneconomy = self.dependencies[AgentPool].get_tokeneconomy()
        marketcap = tokeneconomy.price * tokeneconomy.supply

        random_perc = scipy.stats.norm(**self.distribution_params).rvs(1)[0]
        transactions = random_perc * marketcap

        if self.sign == "any":
            pass
        elif self.sign == "positive":
            transactions = np.abs(transactions)
        elif self.sign == "negative":
            transactions = -np.abs(transactions)

        return transactions


class TransactionManagement_TrendSimple(TransactionManagement):

    def __init__(
        self, start_amount: float, increment: float, noise_addons: [AddOn] = None
    ):
        super(TransactionManagement_TrendSimple, self).__init__()

        self._start_amount = start_amount
        self._increment = increment
        self.transactions_value = 0
        self.iteration = 0
        self._noise_component = noise_addons

    def execute(self):
        dummy_value = self._start_amount + self.iteration * self._increment

        if self._noise_component:
            for noiser in self._noise_component:
                dummy_value = noiser.apply(value=dummy_value)
            dummy_value = max(
                dummy_value, self._start_amount + self.iteration * self._increment
            )

        self.transactions_value = dummy_value
        self.iteration += 1

        return self.transactions_value


class TransactionManagement_Stochastic(TransactionManagement):
    """
    Users a simple binomial distribution to model the number of active users.

    Uses the normal distribution to simulate the transaction value.

    So, at each iteration the execute() function does the following

    1) Uses the binomial distribution to simulate the number of active users.
    2) Uses the value_mean parameter and the value_std to calculate the average value of transactions.
    3) Uses 1 and 2 to get an estimate of the total value.

    Dependent class: The execute() argument is reading from a UserGrowth class that provides
    the current number of users

    """

    def __init__(
        self,
        value_per_transaction: float = None,
        value_distribution: scipy.stats = norm,
        value_dist_parameters: Union[Dict[str, float], List[Dict[str, float]]] = {
            "loc": 1,
            "scale": 10,
        },
        value_drift_parameters: Dict[str, float] = None,
        transactions_per_user: Union[int, List[int]] = None,
        transactions_distribution: scipy.stats = poisson,
        transactions_dist_parameters: Union[
            Dict[str, float], List[Dict[str, float]]
        ] = {"mu": 1},
        transactions_drift_parameters: Dict[str, float] = None,
        name: str = None,
        activity_probs: Union[float, List[float]] = 1,
        type_transaction: str = "positive",
    ) -> None:
        """

        value_per_transaction: If this is set, then the value per transaction is fixed, and overrides the distribution. Otherwise,
        leave to None.

        value_dist_parameters: Parameters for the value distribution. This can also be a list of dictionaries, where each dictionary
        within the list is a set of parameters. The values inside the dictionary must use the keys 'loc' and 'scale'.

        value_distribution: by default this is the normal distribution, but any scipy distribution
         is supported.


        value_drift_parameters: If this is set, then the value dist parameters change at every iteration by adding those values to the value parameters.

        transactions_distribution: uses a distribution to model the number of transactions per user. By default
        this is a Poisson distribution

        transactions_dist_parameters: Parameters for the transaction distribution. This can also be a list of dictionaries, where each dictionary
        within the list is a set of parameters.

        transactions_drift_parameters: If this is set, then the parameters of the distribution for transactions change at every iteration, by adding those values to the parameters.

        transactions_per_user: If this is not None, then the expected number of transactions is equal to this constant.
        In the back-scenes, this creates a uniform distribution with bounds [transactions_constant,transactions_constant]

        type_transaction: positive (positive transactions only), negative or mixed. It is positive by default


        The value at each iteration of execution is sampled from the value distribution (if the distribution is set)

        The final equation is using the following formulas when value distribution is active:

        total value = distribution(loc,scale)
        a) loc = num_active_users*num_transactions*value_per_transaction(or loc parameter)
        b) scale = scale

        If the value distribution is absent, and a value_per_transaction is defined instead, then
        the formula becomes:

        total value = val_mean*self.active_users*trans

        activity_probs: This is either a float or a list of floats, and determines the parameter p of the binomial
        distribution. Note: This is there for legacy reasons. You are recommended to use

        NOTE: Average transactions per user can never be below 0. If 0 (due to random sampling) then it's set to 1


        """
        super(TransactionManagement_Stochastic, self).__init__()
        self.name = name

        self.active_users = 0
        self.total_users = 0
        self._transactions_value_store = []

        self.dependencies = {AgentPool: None}

        self.activity_probabilities = activity_probs

        if transactions_per_user != None:
            transactions_distribution = None
            transactions_dist_parameters = None
            print(
                "transactions_constant is not None. Overriding transactions_dist_parameters and transactions_per_user"
            )

        if value_per_transaction != None:
            value_distribution = None
            value_dist_parameters = None
            print(
                "value_per_transaction is not None. Overriding transactions_dist_parameters and transactions_per_user"
            )

        self.transactions_distribution = transactions_distribution
        self.transactions_per_user = transactions_per_user
        self.transaction_dist_parameters = transactions_dist_parameters
        self.transactions_drift_parameters = transactions_drift_parameters

        self.value_distribution = value_distribution
        self.value_per_transaction = value_per_transaction
        self.value_dist_parameters = value_dist_parameters
        self.value_drift_parameters = value_drift_parameters

        if type_transaction not in ["positive", "negative", "mixed"]:
            raise Exception(
                "You must define a type_transaction as positive, negative or mixed"
            )

        self.type_transaction = type_transaction

        if value_per_transaction is None and value_dist_parameters is None:
            raise Exception(
                "You need to define at least one of: value per transaction or value_dist_parameters"
            )

        if (
            transactions_per_user is None
            and transactions_dist_parameters is None
            and transactions_per_user is None
        ):
            raise Exception(
                "You need to define at least one of: transactions_per_user or transaction_dist_parameters or transactions_constant"
            )

        # sanity test, all lists should be the same length
        lengths = []
        if isinstance(self.value_dist_parameters, (list, np.ndarray)):
            self.max_iterations = len(self.value_dist_parameters)
            lengths.append(len(self.value_dist_parameters))

        if isinstance(self.transaction_dist_parameters, (list, np.ndarray)):
            self.max_iterations = len(self.transaction_dist_parameters)
            lengths.append(len(self.transaction_dist_parameters))

        if isinstance(self.activity_probabilities, (list, np.ndarray)):
            self.max_iterations = len(self.activity_probabilities)
            lengths.append(len(self.activity_probabilities))

        if len(set(lengths)) > 1:
            raise Exception(
                "When supplying lists as arguments, they should all have the same length."
            )

        return None

    def execute(self, dependency: str = "AgentPool") -> float:
        if dependency == "AgentPool":
            dependency = AgentPool
        elif dependency == "TokenEconomy":
            dependency = TokenEconomy
        else:
            raise Exception("You must use either AgentPool or TokenEconomy")

        num_users = self.dependencies[dependency]["num_users"]
        self.total_users = int(num_users)

        # Start by estimating how many users are actually active
        # because activitiy_probabilities can be either an int or a list, we have to take into account both scenarios
        if isinstance(self.activity_probabilities, (list, np.ndarray)):
            act = self.activity_probabilities[self.iteration]
        else:
            act = self.activity_probabilities

        seed = int(int(time.time()) * np.random.rand())
        self.active_users = int(binom.rvs(int(num_users), act, random_state=seed))

        if isinstance(self.transaction_dist_parameters, (list, np.ndarray)):
            trans_param = self.transaction_dist_parameters[self.iteration]
        else:
            trans_param = self.transaction_dist_parameters

        # Get the transactions.
        if self.transactions_per_user is None:
            seed = int(int(time.time()) * np.random.rand())
            trans = np.mean(
                self.transactions_distribution.rvs(
                    size=1000, **trans_param, random_state=seed
                )
            )
        else:
            trans = int(self.transactions_per_user)

        # multiply average transactions per user times the number of users
        self.num_transactions = trans

        if isinstance(self.value_dist_parameters, (list, np.ndarray)):
            val_param = self.value_dist_parameters[self.iteration]
        else:
            val_param = self.value_dist_parameters

        if self.value_per_transaction is None:
            seed = int(int(time.time()) * np.random.rand())
            value_mean = np.mean(
                self.value_distribution.rvs(size=1000, **val_param, random_state=seed)
            )

            # try:
            #     value_mean=np.mean(self.value_distribution.rvs(size=1000,loc=val_param['loc'],scale=val_param['scale'],random_state=seed))
            # except:
            #     value_mean=np.mean(self.value_distribution.rvs(size=1000,**val_param,random_state=seed))

        else:
            value_mean = self.value_per_transaction

        value_total = trans * value_mean * self.active_users

        # transaction value can never be negative
        if value_total < 0 and self.type_transaction == "positive":
            value_total = 0
        elif value_total > 0 and self.type_transaction == "negative":
            value_total = 0

        # total value is average expected value times the number of transactions
        self.transactions_value = value_total

        self._transactions_value_store.append(value_total)

        if self.value_drift_parameters != None:
            for key in self.value_drift_parameters.keys():
                self.value_dist_parameters[key] += self.value_drift_parameters[key]

        if self.transactions_drift_parameters != None:
            for key in self.transactions_drift_parameters.keys():
                self.transaction_dist_parameters[
                    key
                ] += self.transactions_drift_parameters[key]

        self.iteration += 1
        return self.transactions_value
