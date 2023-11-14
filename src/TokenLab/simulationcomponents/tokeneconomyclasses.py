#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Thu Nov  3 11:15:50 2022

@author: stylianoskampakis
"""

import numpy as np
import scipy
from scipy.stats import binom,norm
from typing import Union,TypeVar,Callable
from typing import List, Dict,Union,Tuple
from baseclasses import Controller,TokenEconomy
from agentpoolclasses import AgentPool
from collections import OrderedDict
import pandas as pd
import copy
#import seaborn as sns
from tqdm import tqdm
from matplotlib import pyplot as plt
from pricingclasses import *
import matplotlib
import random
from supplyclasses import *
import warnings


                    
        
        
    
class TokenEconomy_Basic(TokenEconomy):
    
    """
    Basic token economy class. It is using the following assumptions
    
        
        1) There can be multiple agent pools whose transactions are denominated in fiat. They are independent.
        2) There can be multiple pools whose transactions are denominated in the token. If so, then the transaction value
    in fiat is calculated taking into account the current price.
        3) Agent pools always act independently.
        4) The holding time is an average across the whole ecosystem.   
        5) There can be external inputs into the system in fiat. if such inputs exist, then they are added into the overall transaction volume

    
    At each iteration the following happens:
        
        1) Calculate any income in fiat
        2) Calculate the income from token sales, using the current price levels, and convert them to fiat.
        3) Calculate holding time and supply
        4) Use the pricing function to get the new price
    

    Properties:
        
        The TokenEconomy class has many properties, including some hidden ones. It's suggested
        that you use the function get_data() to get access to those properties.
        
        transactions_value_in_fiat: the effective total transaction volume in the fiat currenc.
        
        transactions_volume_in_tokens: the effective total volume of transactions. It's 
        the user's choice as to whether this is taken into account for the holding time calculation
        or ignored. This takes place via the holding_time controller.
        
        holding_time: the holding time used in the simulation.
        
        effective_holding_time: The holding time value that we would get if we would use equation of exchange
        with holding time as an unknown.
        
        num_users: The current number of users.
    """
    
    def __init__(self,
                 holding_time:Union[float,HoldingTimeController],supply:Union[float,SupplyController],
                 initial_price:float,
                 fiat:str='$',token:str='token',price_function:PriceFunctionController=PriceFunction_EOE,
                 price_function_parameters:Dict={},supply_pools:List[SupplyController]=[],
                 unit_of_time:str='month',agent_pools:List[AgentPool]=None,burn_token:bool=False,
                 supply_is_added:bool=True,name:str=None,safeguard_current_supply_level:bool=False,
                 ignore_supply_controller:bool=False)->None:

        

        """

        Parameters
        ----------
        holding_time : Union[float,HoldingTimeController]
            DA controller determining how the holding time is being calculated..
        supply : Union[float,SupplyController]
            the core supply, or a supply controller that determines the release schedule.

        initial_price : float
            The starting price.
        fiat : str, optional
            The fiat currency. The default is '$'.
        token : str, optional
            The name of the token. The default is 'token'. This is also use in some checks, e.g. agent pools
            must either be in fiat or the token.
        price_function : PriceFunctionController, optional
            A controller that determines the price of the token. The default is PriceFunction_EOE.
        price_function_parameters : Dict, optional
            the parameters for the pricing controller. The default is {}.
        supply_pools : List[SupplyController], optional
            Additional pools that might add or subtract from the supply, e.g. investors that are dumping tokens as they are vested
            or a random burning mechanism. The default is [].
        unit_of_time : str, optional
            The unit of time The default is 'month'. This doesn't have any real effect on the simulations for now.
        agent_pools : List[AgentPool], optional
            The list of agent pools. The default is None.
        supply_is_added : bool
            If True, then the circulating supply is added to the current supply. 
            Otherwise, it's just provided as the ground truth. True is the default behaviour. The constant supply controller is set for this behaviour
            returning 0 after the 1 iteration.
        
        burn_token : bool, if True, then the tokens are burned at every iteration after being used
        
        safeguard_current_supply_level : bool, if True, then it protects the current supply from simulated transactions. It caps
        transactions by the maximum circulating supply. If mechanisms like bonding curves are used, this is not needed. Also,
        some simulations might not require it. It always operates after the 2nd iteration onwards.

        Returns
        -------
        None

        """        
        
        
       
        
        super(TokenEconomy_Basic,self).__init__(holding_time=holding_time,supply=supply,fiat=fiat,token=token,
                                                price_function=price_function, 
                                                unit_of_time=unit_of_time,token_initial_price=[initial_price],name=name)
        
        
        if type(holding_time)==float or type(holding_time)==int:
            self._holding_time_controller=HoldingTime_Constant(holding_time)
        else:
            self._holding_time_controller=holding_time
            
        self._holding_time_controller.link(TokenEconomy,self)
            
        if type(supply)==float or type(supply)==int:
            self._supply=SupplyController_Constant(supply)
        elif type(supply)==list or type(supply)==type(np.array([1,2,3])):
            self._supply=SupplyController_FromData(supply)
        else:
            self._supply=supply
            
        self._supply.link(TokenEconomy,self)
            
        self.price=initial_price
        
        self._price_function=price_function(**price_function_parameters)
        self._price_function.link(TokenEconomy,self)
        
        #Note: The code is creating a list here, so that the structure is compatible with the structure of inherited classes
        #which allow for multiple tokens
        self.tokens=[token]
        
        self.holding_time=self._holding_time_controller.get_holding_time()
        
        if agent_pools!=None:
            self.add_agent_pools(agent_pools)
            
        if supply_pools!=None:
            self.add_supply_pools(supply_pools)
            
        self.initialised=False
        
        self.burn_token=burn_token
        
        self.supply_is_added = supply_is_added
        
        self.safeguard_current_supply_level = safeguard_current_supply_level
        
        self.ignore_supply_controller = ignore_supply_controller
            
        
        return None
    
    
    
    def add_agent_pool(self,agent_pool:AgentPool)->bool:
        """
        

        Parameters
        ----------
        agent_pool : AgentPool
            The agent pool to be added. Appropriate tests are done.

        Raises
        ------
        Exception
            Raises an exception if the pool does not have the appropriate token name or is not using fiat (either/or).

        Returns
        -------
        bool
            True if the pool has been added successfully.

        """
        
        if agent_pool.currency!=self.fiat:
            if np.logical_not(agent_pool.currency in self.tokens):
                raise Exception('The currency of this agent pool is neither the fiat, nor the token')  

        if agent_pool.currency==self.fiat:
            self.fiat_exists=True
            
        if agent_pool.currency in self.tokens:
            self.supply_exists=True
            
        agent_pool.link(TokenEconomy,self)
        self._agent_pools.append(agent_pool)
        
        return True
    
    def add_agent_pools(self,agent_pools_list:List)->bool:
        """
        Convenience function for adding multiple agent pools in one go.

        Parameters
        ----------
        agent_pools_list : List

        Returns
        -------
        bool
            True if the pools were successfuly adeded.

        """
        
        for ag in agent_pools_list:
            self.add_agent_pool(ag)
        
        return True
    
    def add_supply_pool(self,supply_pool:SupplyController)->bool:
        """
        Adds a supply pool. By default, it's assumed that the supply pool is supplying the token of the 
        token economy.
        """
        supply_pool.link(TokenEconomy,self)
        self._supply_pools.append(supply_pool)
        
        return True
        
    def add_supply_pools(self,supply_pools_list:List)->bool:
        """
        Convenience function for adding multiple supply pools in one go.

        Parameters
        ----------
        supply_pools_list : List

        Returns
        -------
        bool
            True if the pools were successfuly added.

        """
        
        for sup in supply_pools_list:
            self.add_supply_pool(sup)
            
        return True
    
    
    def test_integrity(self)->bool:
        """
        Tests whether the agent pools are compatible and whether the token economy
        has the right parameters
        """
        
        if len(self._agent_pools)==0:
            
            raise Exception('You must define and link agent pools!')
        
        for agent in self._agent_pools:
            res=agent.test_integrity()
            if not res:
                raise Warning('Integrity of agent pool is not True. Name of pool: '+str(agent.name))
                return False
            
        if len(set(self._agent_pools))<len(self._agent_pools):
            
            raise Warning('duplicate agent pools detected! It is likely the simulation will not run successfuly!')
            
            
        return True
    
    def initialise(self)->None:
        """
        Initialises any agent pools that need to be initialised. These are pools that inherit from the Initialisable
        class, and require initialisation in order to sort out their dependencies.
        """
        if len(self._agent_pools)==0:
            raise Exception('The token economy is not connected to any agent pools!')
        
        for agent in self._agent_pools:
            if isinstance(agent,Initialisable):
                agent.initialise()
                
        self.supply=0
        self.initialised=True
    
    def execute(self)->bool:
        """
        The main function which is used to simulate one round of the token economy.
        
        The order of operations is as follows:
        
        
        1. Initialise and test integrity.
        
        2. Run the core supply controller.
        
        3. Run the rest of the supply pools. Supply pools add to the total supply. This means
        that if a pool returns a negative value, then this can have the effect of reducing the total supply
        
        4. Run the holding time controller.
        
        5. Execute all agent pools. Calculate an effective transaction volume in fiat and tokens at each iteration.
        Agent pools can also exevute with negative transaction volumes, lowering the price.
        
        6. Get the new number of users that each agent pool produces. Each agent pool can add users
        to the total.
        
        7. Calculate the new price and the new holding time
        
        8. Store all the values generated in relevant store variables.
        
        Return True if executed successfully.
        """
                    
        
        #First, we need to initialise any pools that have not been initialised, and then
        #test the integrity of the token economy
        if not self.initialised:
            self.initialise()
        
        if not self.test_integrity():
            raise Exception('Integrity of pools not correct. Please make sure all agent pools have the correct dependencies.')
            
        #These are the parameters which will be updated after this run of execute()
        self.transactions_value_in_fiat=0
        self.transactions_volume_in_tokens=0
        
        self._temp_agent_pools = []
        self._temp_supply_pools = []
        
        #Run the core supply
        self._supply.execute()
        if not self.ignore_supply_controller:
            if self.supply_is_added:
                self.supply += self._supply.get_supply()
            else:
                self.supply=self._supply.get_supply()

        for supplypool in self._supply_pools+self._temp_supply_pools:
            supplypool.execute()
            self.supply+=supplypool.get_supply()
            # if self.supply_is_added==False:
            #     warnings.warn("""Warning! There are supply pools affecting total supply, but supply_is_added=False. This means that
            #                   in the next iteration, the effect of the supply pools will disappear! 
            #                   Please make sure that this is really the intended behaviour.""")


            
        if self.supply==0:
            warnings.warn('Warning! Supply reached 0! Iteration number {0}'.format(self.iteration))
            
        if self.supply<0:
            warnings.warn('Warning! Supply reached BELOW 0! Iteration number {0}'.format(self.iteration))
            return False
        
        
        
        #Get the holding time
        self.holding_time=self._holding_time_controller.get_holding_time()
        
        #Execute agent pools
        for agent in self._agent_pools+self._temp_agent_pools:
            new_pools = agent.execute()
            if agent.currency==self.token:
                tokens = agent.get_transactions()
                
                if tokens>0:
                    self.transactions_volume_in_tokens+=tokens
                    self.transactions_value_in_fiat+=agent.get_transactions()*self.price
                #negative tokens, indicates sell pressure, which indicates that the supply has increased
                #this will push prices downward
                if tokens<=0:
                    self.supply+=np.abs(tokens)
            elif agent.currency==self.fiat:
                transactions = agent.get_transactions()
                if transactions>0:
                    self.transactions_value_in_fiat+=transactions
                else:
                    new_tokens = transactions/self.price
                    self.supply+=np.abs(new_tokens)
                if self.price>0:
                    # self.transactions_volume_in_tokens=agent.get_transactions()*self.holding_time/self.price
                    self.transactions_volume_in_tokens=agent.get_transactions()/self.price
                else:
                    warnings.warn('Warning! Price reached 0 at iteration : '+str(self.iteration+1))
                    return False
                
                if self.safeguard_current_supply_level:
                    if self.transactions_volume_in_tokens > self.supply and self.iteration>0:
                        self.transactions_volume_in_tokens = self.supply
                        self.transactions_value_in_fiat = self.transactions_volume_in_tokens*self.price
                
            else:
                raise Exception('Agent pool found that does not function in neither fiat nor the token! Please specify correct currency!')
            self.num_users=agent.get_num_users()
            
            #Agent pools can spawn new pools. This is primarily used in staking.
            
            if new_pools!=None:
                for pool in new_pools:
                    if pool[0]=='AgentPool':
                        self._temp_agent_pools.append(pool[1])
                    if pool[0]=='SupplyPool':
                        self._temp_supply_pools.append(pool[1])
        
        
        #Calculate price and the new holding time
        self._price_function.execute()
        self._holding_time_controller.execute()        
        
        #Store the parameters
        self.price=self._price_function.get_price()

        self._holding_time_store.append(self.holding_time)
        self._num_users_store.append(self.num_users)
        self._supply_store.append(self.supply)
            
        #this is the holding time if we were simply feeding back the equation of exchange on the current
        #transaction volume in fiat and tokens
        #We add a small number to prevent division by 0
        self._effective_holding_time=self.price*self.supply/(self.transactions_value_in_fiat+0.000000001)
        self._effective_holding_time_store.append(self._effective_holding_time)
             
        
        self._transactions_value_store_in_fiat.append(self.transactions_value_in_fiat)
        self._prices_store.append(self.price)
        self._transactions_value_store_in_tokens.append(self.transactions_volume_in_tokens)
        
        if self.burn_token:
            self.supply-=self.transactions_volume_in_tokens
        
        self.iteration+=1
        
        return True
    
    
    def reset(self)->bool:
        """
        Resets all agent pools and sets the iteration counter to 0.
        """
        
        for agent in self._agent_pools:
            agent.reset()
            
        self.iteration=0
            
        return True
    
    def get_data(self)->pd.DataFrame:
        """
        Returns a data frame with all the important variables for each iteration.

        """
        
        
        df=pd.DataFrame({self.token+'_price':self._prices_store,'transactions_'+self.fiat:self._transactions_value_store_in_fiat,
                        'num_users':self._num_users_store,'iteration':np.arange(1,self.iteration+1),'holding_time':self._holding_time_store,
                        'effective_holding_time':self._effective_holding_time_store,'supply':self._supply_store})
        
        
        df['transactions_'+self.token]=self._transactions_value_store_in_tokens
        return df
    


class TokenMetaSimulator():
    """
    This is a class that can be used to perform multiple simulations with a TokenEconomy class
    and then returns the results.
    
    
    """
    
    
    def __init__(self,token_economy:TokenEconomy)->None:
        self.token_economy=copy.deepcopy(token_economy)
        self.data=[]
        self.repetitions=None
        
        self.unit_of_time=token_economy.unit_of_time
        
    def execute(self,iterations:int=36,repetitions:int=30)->pd.DataFrame:
        repetition_reports=[]
        for i in tqdm(range(repetitions)):
            scipy.stats.rv_continuous.random_state==int(time.time()+int(np.random.rand()))
            token_economy_copy=copy.deepcopy(self.token_economy)
            token_economy_copy.reset()
            it_current_data=[]
            for j in range(iterations):
                result=token_economy_copy.execute()
                #it_current_data.append(token_economy_copy.get_state())
                if not result:
                    break
            it_current_data = token_economy_copy.get_data()
            
            it_current_data['repetition_run']=i
            it_current_data['iteration_time']=np.arange(it_current_data.shape[0])
            
            repetition_reports.append(it_current_data.copy())
        self.data=pd.concat(repetition_reports)
        
        self.repetitions=repetitions
        
        return self.data
    
    
    def get_data(self):
        """
        Returns the simulated data
        """
        
        return self.data
    
    
    def _quantile_10(x):
        
        return np.quantile(x,0.10)
    
    def _quantile_90(x):
        
        return np.quantile(x,0.90)
    
    def get_report(self,functions:List=[np.mean,np.std,np.max,np.min,_quantile_10,_quantile_90],segment:Union[List,Tuple,int,str]=None)->pd.DataFrame:
        """
        segment: 
            a)Either a list with indices [index1,index2] where index1<index2<repetitions
            b) an integer, in which case we choose only a particular repetition
            c) the keyword 'last'
        """
        #
        if segment==None:
            averages=self.data.groupby('repetition_run').mean()
        elif isinstance(segment,list) or isinstance(segment,tuple):
            averages=self.data.loc[(self.data['iteration_time']>segment[0]) & (self.data['iteration_time']<segment[1]),:]
            averages=averages.groupby('repetition_run').mean()
        elif segment=='last':
            averages=self.data[self.data['repetition_run']==self.repetitions].groupby('repetition_run').mean()
            
        df_list=[]
        for func in functions:
            dummy=averages.apply(func)
            dummy.name=func.__name__
            df_list.append(dummy)
        analysis_df=pd.concat(df_list,axis=1)
            
        return analysis_df
    
    
    def get_price_sensitivity_analysis(self):
        if self.data==None:
            raise Exception('You must first run execute() to collect data before using this function!')
            
        pass
            
    def get_timeseries(self,feature:str,use_std:bool=False,log_scale:bool=False,multiple:float=1)->Union[matplotlib.collections.PolyCollection,pd.DataFrame]:
        
        """
        Calculates an average for a certain feature in the report, (e.g. price) and then computes
        a lineplot over time, plus 95% confidence interval. Returns both the plot and the transformed data.
        """
        
        feature_group = self.data.groupby('iteration_time')[feature]
        timeseries_mean = feature_group.mean()*multiple
        timeseries_median = feature_group.median()*multiple
        timeseries_std = feature_group.std()*multiple
        timeseries_quant_10 = feature_group.quantile(0.1)*multiple
        timeseries_quant_90 = feature_group.quantile(0.9)*multiple

        
        final=pd.DataFrame({feature+'_mean':timeseries_mean.values,feature+'_median':timeseries_median.values,
                            'sd':timeseries_std.values,'quant_10%':timeseries_quant_10,
                            'quant_90%':timeseries_quant_90,
                            self.unit_of_time:np.arange(len(timeseries_mean))})
        
        if use_std:
            lower=timeseries_mean-1.96*timeseries_std
            higher=timeseries_mean+1.96*timeseries_std
            toplot=timeseries_mean
        else:
            lower=timeseries_quant_10
            higher=timeseries_quant_90
            toplot=timeseries_median
        
        plt.plot(final[self.unit_of_time].values,toplot)
        plt.xlabel(self.unit_of_time)
        plt.ylabel(feature)
        ax=plt.fill_between(final[self.unit_of_time],lower,higher,alpha=0.2)
        
        if log_scale:
            plt.yscale('log')
        
        plt.show()
        
        return ax,final
    
class TokenEconomy_Dependent(TokenEconomy_Basic):
    
    
    def __init__(self,dependent_token_economy:TokenEconomy_Basic,
                 holding_time:Union[float,HoldingTimeController],supply:Union[float,SupplyController],
                 initial_price:float,
                 fiat:str='tokenA',token:str='tokenB',price_function:PriceFunctionController=PriceFunction_EOE,
                 price_function_parameters:Dict={},supply_pools:List[SupplyController]=[],
                 unit_of_time:str='month',agent_pools:List[AgentPool]=None,burn_token:bool=False,supply_is_added:bool=False,
                 name:str=None,ignore_supply_controller:bool=False)->None:
        
                
        if name==None:
            raise Exception('Dependent token economy must always have a name!')
        
        super(TokenEconomy_Dependent,self).__init__(holding_time=holding_time,supply=supply,\
        initial_price=initial_price,\
        fiat=fiat,token=token,price_function=price_function,\
        price_function_parameters=price_function_parameters,\
        unit_of_time=unit_of_time,burn_token=burn_token,supply_is_added=supply_is_added,name=name,ignore_supply_controller=ignore_supply_controller)
        
        self._token_economy = dependent_token_economy

    
    
    def execute(self):
        
        super(TokenEconomy_Dependent,self).execute()
        prime_token_used = self.transactions_value_in_fiat
        
        #model the transfer of tokens from the main token economy to the dependent one
        self._token_economy.supply -= prime_token_used
    
    
class TokenEcosystem(TokenEconomy):
    
    def __init__(self,token_economies:List[TokenEconomy],randomize_order:bool=False,
                 unit_of_time='month',master:str=None):
        
        self.token_economies = token_economies
        self._randomize = randomize_order
        self.unit_of_time = unit_of_time
        self.master = master
        
        for tokenec in self.token_economies:
            if tokenec.name==None:
                raise Exception('Master token economy and all other token economies need to have a name!')
        
        
    def execute(self):
        if self._randomize:
            random.shuffle(self.token_economies)
            
        for tokenec in self.token_economies:
            tokenec.execute()
            
        return True
            
    def reset(self):
        for tokenec in self.token_economies:
            tokenec.reset()
            
    def get_data(self):
        data = []
        for tokenec in self.token_economies:
            datum = tokenec.get_data()
            datum['name'] = tokenec.name
            cols = datum.columns
            cols=[col+'_'+tokenec.name for col in cols]
            datum.set_axis(cols,axis=1,inplace=True)
            data.append(datum)
        data = pd.concat(data,axis=1)
        
        return data
