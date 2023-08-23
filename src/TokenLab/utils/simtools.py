#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sun Aug  6 11:55:38 2023

@author: stylianoskampakis
"""

import numpy as np
from typing import Union,List,Dict
import scipy
from scipy.stats import lognorm


class Velocity_HoldingTime_Sampler():
    """
    This is a class that samples
    """
    
    
    def __init__(self,parameters_velocity={'loc':0.1,'s':1},
                 parameters_holding_time={'loc':1/0.1,'s':2}):
        self.velocity_distribution_params = parameters_velocity
        self.holding_distribution_params = parameters_holding_time
    
    
    def get_velocity(self,size=1):
        
        samples = lognorm.rvs(**self.velocity_distribution_params,size=size)
        
        return samples
    
    def get_holdingtime(self,size=1):

        samples = lognorm.rvs(**self.holding_distribution_params,size=size)

        return samples
    
    

vel = Velocity_HoldingTime_Sampler()

print(vel.get_velocity())
print(vel.get_holdingtime())