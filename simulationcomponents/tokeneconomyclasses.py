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
from .baseclasses import Controller,TokenEconomy
from .agentpoolclasses import AgentPool
from collections import OrderedDict
import pandas as pd
import copy
#import seaborn as sns
from tqdm import tqdm
from matplotlib import pyplot as plt
from .pricingclasses import *
import matplotlib
import random
from .supplyclasses import *
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
        
        transactions_value_in_fiat: 
        
        transactions_volume_in_tokens: the effective total volume of transactions. It's 
        the user's choice as to whether this is taken into account for the holding time calculation
        or ignored. This takes place via the holding_time controller
        
        holding_time: 
     
        
    """
    
    def __init__(self,
                 holding_time:Union[float,HoldingTimeController],supply:Union[float,SupplyController],initial_price:float,
                 fiat:str='$',token:str='token',price_function:PriceFunctionController=PriceFunction_EOE,
                 price_function_parameters:Dict={},supply_pools:List[SupplyController]=[],
                 unit_of_time:str='month',agent_pools:List[AgentPool]=None)->None:
        
        """
        
        supply: the core supply, or a supply controller that determines the release schedule
        supply_pools: Additional pools that might add or subtract from the supply, e.g. investors that are dumping tokens as they are vested
        or a random burning mechanism
        

        """
        
        super(TokenEconomy_Basic,self).__init__(holding_time=holding_time,supply=supply,fiat=fiat,token=token,
                                                price_function=price_function, 
                                                unit_of_time=unit_of_time,token_initial_price=[initial_price])
        
        
        if type(holding_time)==float or type(holding_time)==int:
            self._holding_time_controller=HoldingTime_Constant(holding_time)
        else:
            self._holding_time_controller=holding_time
            
        self._holding_time_controller.link(TokenEconomy,self)
            
        if type(supply)==float or type(supply)==int:
            self._supply=SupplyController_Constant(supply)
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
            
        
        return None
    
    
    
    def add_agent_pool(self,agent_pool:AgentPool)->bool:
        
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
    
    def add_supply_pool(self,supply_pool:SupplyController)->bool:
  
      
        self._supply_pools.append(supply_pool)
        
        return True
        
    def add_supply_pools(self,supply_pools_list:List)->bool:
        
        for sup in supply_pools_list:
            self.add_supply_pool(sup)
            
        return True
        
    
    def add_agent_pools(self,agent_pools_list:List)->bool:
        
        for ag in agent_pools_list:
            self.add_agent_pool(ag)
        
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
        for agent in self._agent_pools:
            if isinstance(agent,Initialisable):
                agent.initialise()
        self.initialised=True
    
    def execute(self)->bool:
                    
        if not self.initialised:
            self.initialise()
        
        if not self.test_integrity():
            raise Exception('Integrity of pools not correct. Please make sure all agent pools have the correct dependencies.')
            
        
        self._supply.execute()
        self.supply=self._supply.get_supply()
        self.holding_time=self._holding_time_controller.get_holding_time()

        for supplypool in self._supply_pools:
            supplypool.execute()
            self.supply+=supplypool.get_supply()

            
        if self.supply<=0:
            warnings.warn('Warning! Supply reached 0! Iteration number :'+str(self.iteration))
            return False
        
        self.transactions_value_in_fiat=0
        self.transactions_volume_in_tokens=0

        for agent in self._agent_pools:
            agent.execute()
            if agent.currency==self.token:
                self.transactions_volume_in_tokens+=agent.get_transactions()
                self.transactions_value_in_fiat+=agent.get_transactions()*self.price
            elif agent.currency==self.fiat:
                self.transactions_value_in_fiat+=agent.get_transactions()
                if self.price>0:
                    self.transactions_volume_in_tokens=agent.get_transactions()*self.holding_time/self.price
                else:
                    warnings.warn('Warning! Price reached 0 at iteration : '+str(self.iteration+1))
                    return False
            else:
                raise Exception('Agent pool found that does not function in neither fiat nor the token! Please specify correct currency!')
            self.num_users+=agent.get_num_users()
        
        self._holding_time_store.append(self.holding_time)
        self._num_users_store.append(self.num_users)
        self._supply_store.append(self.supply)

        
        self._price_function.execute()
        self.price=self._price_function.get_price()
        
        #this is the holding time if we were simply feeding back the equation of exchange on the current
        #transaction volume in fiat and tokens
        #We add a small number to prevent division by 0
        self._effective_holding_time=self.price*self.supply/(self.transactions_value_in_fiat+0.000000001)
        self._holding_time_controller.execute()

        
        self._transactions_value_store_in_fiat.append(self.transactions_value_in_fiat)
        self._prices_store.append(self.price)
        
        self._transactions_value_store_in_tokens.append(self.transactions_volume_in_tokens)
        
        self.iteration+=1
        
        return True
    
    
    def reset(self)->bool:
        
        for agent in self._agent_pools:
            agent.reset()
            
        self.iteration=0
            
        return True
    
    def get_data(self)->pd.DataFrame:
        
        df=pd.DataFrame({self.token+'_price':self._prices_store,'transactions_'+self.fiat:self._transactions_value_store_in_fiat,
                        'num_users':self._num_users_store,'iteration':np.arange(1,self.iteration+1),'holding_time':self._holding_time_store,
                        'effective_holding_time':self._effective_holding_time,'supply':self._supply_store})
        
        
        df['transactions_'+self.token]=self._transactions_value_store_in_tokens
        return df
    
    
# class TokenEconomy_MultipleTokens(TokenEconomy_Basic):
    
#     """
#     Basic token economy class. It is using the following assumptions
    
        
#         1) There can be multiple agent pools whose transactions are denominated in fiat. They are independent.
#         2) There can be multiple pools whose transactions are denominated in the token. If so, then the transaction value
#     in fiat is calculated taking into account the current price.
#         3) Agent pools always act independently.
#         4) The holding time is an average across the whole ecosystem.        
        
#     """
    
#     def __init__(self,
#                  holding_time:Union[float,HoldingTimeController],supply:Union[float,SupplyController,List[Union[float,SupplyController]]],
#                  fiat:str='$',tokens:List[str]=['tokenA','tokenB'],price_function:PriceFunctionController=PriceFunction_EOE,
#                  price_function_parameters:Dict={},
#                  unit_of_time:str='month',initial_prices:List[float]=[0,0])->None:
        
#         super(TokenEconomy_MultipleTokens,self).__init__(holding_time=holding_time,supply=supply,fiat=fiat,
#                                                 price_function=price_function, 
#                                                 unit_of_time=unit_of_time,token=tokens)
        

#         self.tokens=tokens
#         self._price_functions={}
#         self.prices={}
#         for count,token in enumerate(self.tokens):
#             self._price_functions[token]=copy.deepcopy(price_function(**price_function_parameters))
#             self._price_functions[token].link(TokenEconomy,self)
#             self.prices[token]=initial_prices[count]  
#             if type(supply[count])==float or type(supply[count])==int:
#                 self._supply[token]=SupplyController_Constant(supply)
#             else:
#                 self._supply[token]=supply
#             self.supply[token]=supply[count]
            
        
#         return None
    
#     def execute(self)->bool:
              
#         if not self.test_integrity():
#             raise Exception('Integrity of pools not correct. Please make sure all agent pools have the correct dependencies.')
            
#         self.num_users=0
#         self.transactions_volume_in_tokens={}
#         for tok in self.tokens:
#             self.transactions_volume_in_tokens[tok]=0
#             self.transactions_value_in_fiat[tok]=0
        

#         for agent in self._agent_pools:
#             agent.execute()
#             if agent.currency==self.fiat:
#                 self.transactions_value_in_fiat+=agent.get_transactions()
#             else:
#                 for tok in self.tokens:
#                     if agent.currency==tok:
#                         self.transactions_volume_in_tokens[tok]+=agent.get_transactions()
#                         self.transactions_value_in_fiat[tok]+=agent.get_transactions()*self.prices[tok]
#             self.num_users+=agent.get_num_users()
            
#         self._num_users_store.append(self.num_users)
            
#         self._holding_time_controller.execute()
#         self.holding_time=self._holding_time_controller.get_holding_time()
        
#         for tok in tokens:
#             self._supply[tok].execute()
#             self.supply[tok]=self._supply.get_supply()
        
#         for token in self.tokens:
#             self._price_functions[token].execute()
#             self.prices[token]=self._price_functions[token].get_price()
        
#         self._transactions_value_store_in_fiat.append(self.transactions_value_in_fiat)
#         self._prices_store.append(self.price)
        
#         for tok in self.tokens:
#             self._transactions_value_store_in_tokens[tok].append(self.transactions_volume_in_tokens[tok])
        
        

                            
        
#         self.iteration+=1
        
#         return True

class TokenMetaSimulator():
    
    
    def __init__(self,token_economy:TokenEconomy)->None:
        self.token_economy=copy.deepcopy(token_economy)
        self.data=[]
        self.repetitions=None
        
        self.unit_of_time=token_economy.unit_of_time
        
        
    def get_stats(self,report_dataframe):
        
        pass
        
    def execute(self,iterations:int=36,repetitions=30)->pd.DataFrame:
        iteration_runs=[]
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
            it_current_data=token_economy_copy.get_data()
            iteration_runs.append(it_current_data.copy())
            
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
    
    
    def get_report(self,functions:List=[np.mean,np.std,np.max,np.min],segment:Union[List,Tuple,int,str]=None)->pd.DataFrame:
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
            
    def get_timeseries(self,feature:str)->Union[matplotlib.collections.PolyCollection,pd.DataFrame]:
        
        """
        Calculates an average for a certain feature in the report, (e.g. price) and then computes
        a lineplot over time, plus 95% confidence interval. Returns both the plot and the transformed data.
        """
        
        timeseries_mean=self.data.groupby('iteration_time')[feature].mean()
        timeseries_std=self.data.groupby('iteration_time')[feature].std()
        
        final=pd.DataFrame({feature+'_mean':timeseries_mean.values,
                            'sd':timeseries_std.values,
                            self.unit_of_time:np.arange(len(timeseries_mean))})
        
        lower=timeseries_mean-1.96*timeseries_std
        higher=timeseries_mean+1.96*timeseries_std
        
        plt.plot(final[self.unit_of_time].values,timeseries_mean)
        plt.xlabel(self.unit_of_time)
        plt.ylabel(feature)
        ax=plt.fill_between(final[self.unit_of_time],lower,higher,alpha=0.2)
        
        plt.show()
        
        return ax,final

