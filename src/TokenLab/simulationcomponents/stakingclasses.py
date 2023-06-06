#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Jun  6 10:46:51 2023

@author: stylianoskampakis
"""

from typing import List, Dict,Union
from baseclasses import *
from TokenLab.utils.helpers import log_saturated_space
import scipy
from scipy import stats
from scipy.stats import uniform
import time
import copy



class StakingController(Controller):
    """
    Base class that models staking.
    """
    
    def __init__(self):
        super(StakingController,self).__init__()
        
        #conditional dependence, it is used only in conditions
        self.dependencies={AgentPool:None,TokenEconomy:None}
        
        return None
    
    
    def execute(self)->int:
        self.iteration = self.iteration + 1
        
        if hasattr(self,'_num_users_store'):
            #this is only for precomputed user populations, like UserGrowth_Spaced
            self.num_users=self._num_users_store[self.iteration-1]
        return self.num_users
    
    
    def get_num_users(self)->int:
        
        return self.num_users