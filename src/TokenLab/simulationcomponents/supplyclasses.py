#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Wed Nov 30 11:03:57 2022

@author: stylianoskampakis
"""

from typing import List, Dict, Union, Any
from baseclasses import *
from TokenLab.utils.helpers import log_saturated_space
import scipy
from scipy import stats
from scipy.stats import uniform
import time
import copy
from abc import ABC, abstractmethod
import scipy.stats
from typing import Union


class SupplyController(Controller):
    """
    Base class for other supply controllers.
    """

    def __init__(self):
        super(SupplyController, self).__init__()
        self.supply = None
        self._iteration = 0

    def get_supply(self) -> float:

        return self.supply

    def execute(self) -> float:

        pass

    def reset(self) -> bool:

        self._iteration = 0

        return True


class SupplyController_Constant(SupplyController):
    """
    Most basic type of supply controller. Supply is simply constant
    and doesn't change.
    """

    def __init__(self, supply: float):
        """


        Parameters
        ----------
        supply : float
            The total supply.

        Returns
        -------
        None.

        """
        super(SupplyController_Constant, self).__init__()
        self.supply = supply
        self._iteration = 0

    def execute(self) -> float:

        if self._iteration == 0:
            self._iteration += 1
            return self.supply
        else:
            self._iteration += 1
            self.supply = 0
            return 0


class SupplyController_FromData(SupplyController):

    def __init__(self, values: list, on_end_continue: bool = True):
        """


        Parameters
        ----------
        values : list
            The circulating supply for each iteration.
        on_end_continue : bool, optional
            If True, then the controller will keep providing the last value once it runs out of iterations
            If false, then it will raise an error. The default is True.

        Returns
        -------
        None.

        """
        super(SupplyController_FromData, self).__init__()

        self._supplylist = values
        self._iteration = 0
        self._on_end = on_end_continue

    def execute(self):
        # Check if we have reached the end of the supply list
        if self._iteration < len(self._supplylist):
            self.supply = self._supplylist[self._iteration]
            self._iteration += 1
        else:
            if self._on_end:
                self.supply = self._supplylist[-1]
            else:
                raise Exception(
                    "Supply controller reached the end of iterations and no supply is provided!"
                )


class SupplyController_CliffVesting(SupplyController):
    """
    Implements a cliff vesting schedule for token supply.
    """

    def __init__(
        self,
        token_amount: float,
        vesting_period: int,
        cliff: int,
        name=None,
        delay: int = 0,
    ):
        """
        Parameters
        ----------
        token_amount : float
            The total amount of tokens to be vested.
        vesting_period : int
            The total number of periods over which the tokens will be vested.
        cliff : int
            The initial number of periods with no vesting.
        name : str, optional
            The name of the vesting schedule. The default is None.
        delay : int, optional
            The initial delay before vesting starts. The default is 0.

        Returns
        -------
        None.
        """
        super(SupplyController_CliffVesting, self).__init__()
        self.name = name
        self._data = self._generate_vesting_schedule(
            token_amount, vesting_period, cliff, delay
        )
        self._iteration = 0

    def _generate_vesting_schedule(self, token_amount, vesting_period, cliff, delay):
        """
        Generates the vesting schedule.

        Parameters
        ----------
        token_amount : float
            The total amount of tokens to be vested.
        vesting_period : int
            The total number of periods over which the tokens will be vested.
        cliff : int
            The initial number of periods with no vesting.
        delay : int
            The initial delay before vesting starts.

        Returns
        -------
        data : list
            The vesting schedule as a list of token amounts.
        """
        data = []
        total_tokens = token_amount
        chunk = token_amount / vesting_period if vesting_period > 0 else token_amount

        for period in range(delay + cliff + vesting_period):
            if period < delay:
                data.append(0)
            elif period < delay + cliff:
                data.append(0)
            elif period == delay + cliff:
                data.append(min(total_tokens, chunk))
                total_tokens -= min(total_tokens, chunk)
            else:
                data.append(min(total_tokens, chunk))
                total_tokens -= min(total_tokens, chunk)

        return data

    def execute(self):
        if self._iteration < len(self._data):
            self.supply = self._data[self._iteration]
        else:
            self.supply = 0

        self._iteration += 1

        return self.supply


class SupplyStaker(SupplyController, ABC):
    def __init__(
        self,
        staking_amount: float = 0,
        reward_as_perc: bool = True,
        quit_prob: float = 0,
    ):
        """


        Parameters
        ----------
        staking_amount : float
            DESCRIPTION.
        source : If none, then the source is the token economy. No special treatment required.
            If not None, then this has to be set to a treasury class, and rewards will come from there.

        Returns
        -------
        None.

        """
        super(SupplyController, self).__init__()
        self._staking_amount = staking_amount
        self._iteration = 0
        self.dependencies = {AgentPool: None}
        self.reward_as_perc = True
        self._quit_prob = quit_prob

    def get_staking_amount(self):

        return self._staking_amount

    def get_linked_agentpool(self):

        return self.dependencies[AgentPool]

    def quit_staking(self):

        self._staking_amount = 0

    @abstractmethod
    def execute(self):
        self.source = self.get_linked_agentpool().treasury
        if np.random.rand() < self._quit_prob:
            self.quit_staking()

        pass


class SupplyStakerLockup(SupplyStaker):
    def __init__(
        self,
        staking_amount: Union[float, scipy.stats.rv_continuous],
        rewards: Union[float, scipy.stats.rv_continuous],
        lockup_duration: int,
        reward_as_perc: bool = True,
    ):
        """
        Staking class for lockup types of vaults

        Parameters
        ----------
        staking_amount : Union[float, scipy.stats.rv_continuous]
        rewards : Union[float, scipy.stats.rv_continuous]
            perc or fixed.
        lockup_duration : int
        reward_as_perc : bool, optional
            If true, then the reward is calculated as a percentage of the staked amount. Otherwise it is fixed. The default is True.

        Returns
        -------
        None.

        """
        super(SupplyStakerLockup, self).__init__(staking_amount, quit_prob=quit_prob)
        self.lockup_duration = lockup_duration
        self.reward_as_perc = reward_as_perc

    def execute(self):
        self.source = get_linked_agentpool().treasury

        if self._iteration == 0:
            value = -1 * self._get_value(self.staking_amount)
            self._staking_amount = value
        elif self._iteration == self.lockup_duration:
            if not self.reward_as_perc:
                value = self._staking_amount + self._get_value(self.rewards)
            else:
                value = (
                    self._staking_amount
                    + self._get_value(self.rewards) * self._staking_amount
                )
        else:
            value = 0  # No change in supply for other iterations

        if self.source is None:
            self.supply = value
        else:
            agentpool = get_linked_agentpool()
            currency = agentpool.currency
            # remove from treasury
            agentpool.treasury.retrieve_asset(currency_symbol=currency, value=value)
            # the circulating supply increases in accordance with the total reward
            self.supply = abs(value)

        self._iteration += 1

        if np.random.rand() < self._quit_prob:
            self.quit_staking()

    def _get_value(self, param):
        try:
            return param.rvs(1)[0]  # Sample from the distribution
        except:
            return param  # Use the float value directly


class SupplyStakerMonthly(SupplyStaker):
    def __init__(
        self,
        staking_amount: Union[float, scipy.stats.rv_continuous],
        rewards: Union[float, scipy.stats.rv_continuous],
        reward_as_perc: bool = True,
        quit_prob: float = 0,
    ):
        """
        Staking class for monthly rewards.

        If a treasury is used tokens go back to treasury, and rewards are taken from there as well.

        Once rewards are given, they return into circulating supply

        Parameters
        ----------
        staking_amount : Union[float, scipy.stats.rv_continuous]
        rewards : Union[float, scipy.stats.rv_continuous]
            perc or fixed.
        reward_as_perc : bool, optional
            If true, then the reward is calculated as a percentage of the staked amount. Otherwise it is fixed. The default is True.

        Returns
        -------
        None.

        """
        super(SupplyStakerMonthly, self).__init__(quit_prob=quit_prob)
        self.staking_amount = staking_amount
        self.rewards = rewards
        self.reward_as_perc = reward_as_perc

    def execute(self):
        self.source = super().get_linked_agentpool().treasury

        if self._iteration == 0:
            value = -1 * self._get_value(self.staking_amount)
            self._staking_amount = value
        else:
            # monthly rewards
            if not self.reward_as_perc:
                value = self._get_value(self.rewards)
            else:
                value = self._get_value(self.rewards) * self._staking_amount

        if self.source is None:
            self.supply = value
        else:
            agentpool = super().get_linked_agentpool()
            currency = agentpool.currency
            # remove from treasury
            agentpool.treasury.execute(currency_symbol=currency, value=value)
            # the circulating supply increases in accordance with the total reward
            self.supply = abs(value)

        self._iteration += 1

        if np.random.rand() < self._quit_prob:
            self.quit_staking()

    def _get_value(self, param):
        try:
            return param.rvs(1)[0]
        except:
            return param


class SupplyController_Bonding(SupplyController):
    """
    This is a supply class that is used only alongside bonding curves.

    It simply uses the estimated number of tokens in the economy, and translates this into supply.
    """

    def __init__(self):
        super(SupplyController_Bonding, self).__init__()
        self.dependencies = {TokenEconomy: None}
        self.supply = 0

    def execute(self):
        tokeneconomy = self.dependencies[TokenEconomy]

        if len(tokeneconomy._transactions_value_store_in_tokens) > 0:
            self.supply = tokeneconomy._transactions_value_store_in_tokens[-1]


class SupplyController_AdaptiveStochastic(SupplyController):
    """
    An advanced supply controller for simulations that models the dynamics of circulating and total supply.

    This class assumes that in each iteration, a portion of tokens purchased is removed from circulation,
    and a random percentage of those tokens returns in the next iteration.

    The class simulates both total supply and circulating supply, attaching itself to a TokenEconomy
    and directly reading transaction volume, price, and holding time.
    """

    def __init__(
        self,
        removal_distribution: scipy.stats = uniform,
        removal_dist_parameters: Dict[str, Any] = {"loc": 0, "scale": 0.1},
        addition_distribution: scipy.stats = uniform,
        addition_dist_parameters: Dict[str, Any] = {"loc": 0, "scale": 0.05},
        return_negative: bool = True,
    ):
        """
        Initializes the SupplyController_AdaptiveStochastic class.

        Parameters
        ----------
        removal_distribution : scipy.stats distribution, optional
            A distribution that determines the percentage of supply removed from circulation in each iteration.
            The distribution must return values in the range [0,1]. Default is uniform.

        removal_dist_parameters : dict, optional
            Parameters for the removal distribution. Default is {'loc': 0, 'scale': 0.1}.

        addition_distribution : scipy.stats distribution, optional
            A distribution that determines the percentage of removed tokens that return to circulation
            in each iteration. Default is uniform.

        addition_dist_parameters : dict, optional
            Parameters for the addition distribution. Default is {'loc': 0, 'scale': 0.05}.

        return_negative : bool, optional
            If True, the `execute()` function can return a negative value, indicating a net removal from the supply.
            Default is True.
        """
        self.dependencies = {TokenEconomy: None}
        self.inactive_tokens = 0

        self._removal_distribution = removal_distribution
        self._removal_dist_parameters = removal_dist_parameters

        self._addition_distribution = addition_distribution
        self._addition_dist_parameters = addition_dist_parameters

        self.return_negative = return_negative
        self.supply = 0

    def execute(self) -> None:
        """
        Executes the supply control logic for the current iteration.

        This method performs the following steps:
        1. Reads the total purchases of tokens from the TokenEconomy.
        2. Calculates the tokens to be removed from circulation.
        3. Calculates the tokens to be added back to circulation.
        4. Updates the total supply based on these calculations.

        If the total supply becomes less than or equal to zero and `return_negative` is False,
        the supply will not decrease below zero.
        """
        # Step 1: Calculate purchases_in_tokens based on current supply
        tokeneconomy = self.dependencies[TokenEconomy]
        purchases_in_tokens = (
            tokeneconomy.transactions_volume_in_tokens
            * tokeneconomy.holding_time
            / tokeneconomy.price
        )

        # Step 2: Calculate the percentage and amount of tokens to be removed
        seed = int(time.time() * np.random.rand())
        percentage_removal = self._removal_distribution.rvs(
            size=1, **self._removal_dist_parameters, random_state=seed
        )[0]
        token_removal = purchases_in_tokens * percentage_removal
        self.inactive_tokens += token_removal

        # Step 3: Calculate the percentage and amount of tokens to be added back
        percentage_addition = self._addition_distribution.rvs(
            size=1, **self._addition_dist_parameters, random_state=seed
        )[0]
        tokens_coming_back = self.inactive_tokens * percentage_addition
        self.inactive_tokens -= tokens_coming_back

        # Step 4: Update the total supply
        new_supply = self.supply + tokens_coming_back - token_removal

        if new_supply <= 0 and not self.return_negative:
            new_supply = self.supply + tokens_coming_back

        self.supply = new_supply


class SupplyController_Burn(SupplyController):
    """
    Simulates a burn mechanism.
    """

    def __init__(self, burn_param=0.05, burn_style="perc", self_destruct: bool = False):
        """


        Parameters
        ----------
        burn_param : int or float, optional
            Used alongside burn_style (Explained below) The default is 0.05.
        burn_style : TYPE, optional
            Choose 'perc' or 'fixed'. The default is 'perc'. Percentage means
            that you burn a %burn_param number of tokens at each iteration.

            Otherwise you burn a fixed number pf tokens equal to burn_param
        self_destruct: If True, then this supply pool works only once.

        Returns
        -------
        None.

        """

        super(SupplyController_Burn, self).__init__()

        self.burn_param = burn_param
        self.burn_style = burn_style

        self.dependencies = {TokenEconomy: None}

        self.self_destruct = self_destruct

    def execute(self):

        tokeneconomy = self.dependencies[TokenEconomy]

        current_supply = tokeneconomy.supply

        if self.burn_style == "perc":
            burn_tokens = -1 * current_supply * self.burn_param
        elif self.burn_style == "fixed":
            burn_tokens = -1 * self.burn_param
        else:
            raise Exception(
                'SupplyController_Burn Exception! You must define burn_style as either "fixed" or "perc"'
            )

        self.supply = burn_tokens

        self.iteration += 1

        if self.self_destruct:
            self.burn_param = 0


class SupplyController_InvestorDumperSpaced(SupplyController):
    """
    Simulates an investor pool that is just dumping the coin in a predictable fashion. Supports noise addons.
    """

    def __init__(
        self,
        dumping_initial: float,
        dumping_final: float,
        num_steps: int,
        space_function: Union[
            np.linspace, np.logspace, np.geomspace, log_saturated_space
        ] = np.linspace,
        name: str = None,
        noise_addon: AddOn = None,
    ):
        """
        Parameters
        ----------
        dumping_initial : float
            The initial number of tokens to be dumped.
        dumping_final : float
            The final number of tokens to be dumped.
        num_steps : int
            The number of iterations the simulation will go for.
        space_function : Union[np.linspace,np.logspace,np.geomspace,log_saturated_space], optional
            A function that will generate the sequence of supply points. The default is np.linspace.
        name : str, optional
            The name of this controller. The default is None.
        noise_addon : AddOn, optional
            Noise AddOn from the AddOns module. The default is None.
        """
        super(SupplyController_InvestorDumperSpaced, self).__init__()

        self.name = name
        self.num_steps = num_steps
        self.space_function = space_function
        self._noise_component = noise_addon

        self._dumping_store_original = self._generate_dumping_store(
            dumping_initial, dumping_final
        )
        self._dumping_store = self._apply_noise(self._dumping_store_original)

        self._dumped_tokens_store = []
        self.max_iterations = num_steps
        self.iteration = 0

    def _generate_dumping_store(self, start: float, stop: float) -> np.ndarray:
        """
        Generates the dumping store sequence using the space function.
        """

        return np.round(
            self.space_function(start=start, stop=stop, num=self.num_steps)
        ).astype(int)

    def _apply_noise(self, dumping_store: np.ndarray) -> np.ndarray:
        """
        Applies noise to the dumping store if noise component is present.
        """

        if not self._noise_component:
            return dumping_store
        noisy_store = []
        for value in dumping_store:
            noisy_value = value + self._noise_component.apply(value=value)
            noisy_store.append(max(noisy_value, value))
        return np.array(noisy_store)

    def execute(self) -> float:
        """
        Simply executes the controller and updates the supply.

        Returns
        -------
        float
            The supply of tokens dumped.

        """

        self.dumping_number = self._dumping_store[self.iteration]

        self._dumped_tokens_store.append(self.dumping_number)

        self.supply = self.dumping_number

        self.iteration += 1
        return self.dumping_number

    def get_dumped_store(self):

        return self._dumping_store


class SupplyController_Speculator(SupplyController):
    """
    This class models a speculative behavior where a portion of transactions is assumed to be speculative in each iteration.
    Speculative tokens are removed from the circulating supply and stored with the bid price.
    These tokens are sold at a later time based on specific price conditions, following a "buy and hold" strategy.
    The speculator will sell tokens only when the price reaches certain profit or loss thresholds.
    """

    def __init__(
        self,
        speculation_distribution: scipy.stats = uniform,
        speculation_dist_parameters: Dict[str, Any] = {"loc": 0, "scale": 0.1},
        take_profit: float = 1.1,
        stop_loss: float = 0.9,
        max_prop_to_supply: float = 0.9,
    ):
        """
        Initializes the SupplyController_AdaptiveStochastic class.

        Parameters
        ----------
        speculation_distribution : scipy.stats distribution, optional
            A distribution that determines the percentage of supply removed from circulation in each iteration.
            The distribution must return values in the range [0,1]. Default is uniform.

        speculation_dist_parameters : dict, optional
            Parameters for the removal distribution. Default is {'loc': 0, 'scale': 0.1}.

        take_profit : float, optional
            Speculators choose to sell when the ratio of the market price to the bid price exceeds this ratio.

        stop_loss : float, optional
            Speculators choose to sell when the ratio of the market price to the bid price is lower than this ratio.

        max_prop_to_supply : float, optional
            The maximum proportion of the circulating supply that the speculator can hold at any time. Default is 0.1.
        """
        super(SupplyController_Speculator, self).__init__()

        self.dependencies = {TokenEconomy: None}

        self._speculation_distribution = speculation_distribution
        self._speculation_dist_parameters = speculation_dist_parameters

        self.speculation_list = [] # record of all speculations
        self.supply = 0 # token held by speculators

        self.take_profit = take_profit
        self.stop_loss = stop_loss

        self.max_prop_to_supply = max_prop_to_supply

    def execute(self) -> None:
        """
        Steps:
        1. Read transaction volume in tokens and current price from the token economy.
        2. Check the list of previous bought tokens if their selling conditions are met. If so, sell them, and add the circulating supply.
        3. The speculator will buy a number of tokens in a iteration, this number, along with the buying price, will be stored.
        4. Check if the speculator can hold this amount of tokens.
        5. The token number will be removed from the circulating supply.
        6. Return the supply change.
        """
        # Step 1: Read transaction volume in tokens and current price from the token economy.
        tokeneconomy = self.dependencies[TokenEconomy]
        price = tokeneconomy.price
        max_speculation_token = tokeneconomy.supply * self.max_prop_to_supply
        transactions_value_in_fiat = tokeneconomy.transactions_value_in_fiat

        # Step 2: Check the list of previous bought tokens if their selling conditions are met. If so, sell them, and add the circulating supply.
        for speculation in self.speculation_list:
            if (
                price > speculation["upper_price_bond"]
                or price < speculation["lower_price_bond"]
            ):
                self.supply += speculation["number_token_speculation"]
                speculation["number_token_speculation"] = 0

        # Step 3: The speculator will buy a number of tokens in a iteration, this number, along with the buying price, will be stored.
        seed = int(time.time() * np.random.rand())
        percentage_speculation = self._speculation_distribution.rvs(
            size=1, **self._speculation_dist_parameters, random_state=seed
        )[0]
        number_token_speculation = (
            transactions_value_in_fiat * percentage_speculation / price
        )
        # Step 4: Check if the speculator can hold this amount of tokens.
        if np.abs(self.supply - number_token_speculation) > max_speculation_token:
            number_token_speculation = max_speculation_token + self.supply

        speculation_dict = {
            "number_token_speculation": number_token_speculation,
            "price": price,
            "iteration": tokeneconomy.iteration,
            "upper_price_bond": price * self.take_profit,
            "lower_price_bond": price * self.stop_loss,
        }
        self.speculation_list.append((speculation_dict))

        # Step 5: The token number will be removed from the circulating supply.
        self.supply -= number_token_speculation

        # Step 6: Return the supply change.
        return self.supply
