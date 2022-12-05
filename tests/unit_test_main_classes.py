#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue Nov 15 15:33:02 2022

@author: stylianoskampakis
"""

import sys
sys.path.insert(0,'..')
import unittest
from simulationcomponents import *
from simulationcomponents.usergrowthclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.tokeneconomyclasses import *
from simulationcomponents.transactionclasses import *
from simulationcomponents.agentpoolclasses import *
from simulationcomponents.pricingclasses import *
from simulationcomponents.addons import *
from utils.helpers import *


class TestMainClasses(unittest.TestCase):
    
    def test_user_growth_store(self):
        usm=UserGrowth_Spaced(10,1000,72,np.linspace)
        store=[  10,   24,   38,   52,   66,   80,   94,  108,  122,  135,  149,
                163,  177,  191,  205,  219,  233,  247,  261,  275,  289,  303,
                317,  331,  345,  359,  373,  386,  400,  414,  428,  442,  456,
                470,  484,  498,  512,  526,  540,  554,  568,  582,  596,  610,
                624,  637,  651,  665,  679,  693,  707,  721,  735,  749,  763,
                777,  791,  805,  819,  833,  847,  861,  875,  888,  902,  916,
                930,  944,  958,  972,  986, 1000]
        
        assert (usm._num_users_store,store)


    def test_transaction_management_stochastic(self):
        store=[]
        for i in range(100):
            usm=UserGrowth_Spaced(100,327,72,np.linspace)
            tsm=TransactionManagement_Stochastic(activity_probs=0.5,transactions_per_user=1)
                                                 
            tsm.link(UserGrowth,usm)
            store.append(tsm.execute())
        mean=np.mean(store)
        print(mean)
        self.assertTrue(100 <= mean <= 1500)
            
        
    def test_agent_pool(self):
        
        usm=UserGrowth_Spaced(10,1000,72,np.linspace)
        tsm=TransactionManagement_Stochastic(activity_probs=0.5,
                                             transactions_per_user=1)

        ap=AgentPool_Basic(users_controller=usm,transactions_controller=tsm)
        ap.execute()
        
        report=ap.report()
        
        users=report['users']==10
        transactions=report['transactions']<1500 and report['transactions']>=0
        final=users+transactions
        
        self.assertTrue(final)
        
    def test_general(self):
        
        ITERATIONS=72
        
        usm=UserGrowth_Spaced(10000,327800,ITERATIONS,np.linspace)
        tsm=TransactionManagement_Stochastic(activity_probs=np.linspace(0.25,0.1,ITERATIONS),transactions_per_user=1)
                                                                                 
        ap=AgentPool_Basic(users_controller=usm,transactions_controller=tsm)
        ap.execute()
        assert(True)
        
        
    def test_helper_generators_harmoniser(self):
        p1=generate_distribution_param_from_sequence('loc',np.linspace,500,750,72)
        p2=harmonize_param_sequence(p1,'scale',100)
        
        self.assertTrue(p1[0]['loc']==500 and p1[0]['scale']==100,'generators test failed')
        
        
    def test_helper_generators_merger(self):
        p1=generate_distribution_param_from_sequence('loc',np.linspace,500,750,72)
        list2=generate_distribution_param_from_sequence('scale',np.linspace,500/7,750/7,72)
        list3=merge_param_dists(p1,list2)
        
        self.assertTrue(p1[0]['loc']==500 and p1[71]['scale']>107)
        
    def test_holding_controller_stochastic(self):
        contr=HoldingTime_Stochastic()
        time=contr.execute()
        
        self.assertTrue(0<time<3)
        
        
    def test_condition2(self):
        
        usm_fiat=UserGrowth_Spaced(100,54000,100,log_saturated_space)
        ap_fiat=AgentPool_Basic(users_controller=usm_fiat,transactions_controller=100,currency='$')
        ap_fiat.execute()

        
        result=Condition(sim_component=ap_fiat,variables=['transactions'],condition=lambda x:x[0]>1000).execute()
        self.assertTrue(result)
        
        
            
    def test_condition2(self):
        
        usm_fiat=UserGrowth_Spaced(100,54000,100,log_saturated_space)
        ap_fiat=AgentPool_Basic(users_controller=usm_fiat,transactions_controller=100,currency='$')
        ap_fiat.execute()
        
        result=Condition(sim_component=ap_fiat,variables=['transactions'],condition=lambda x:x[0]< -100).execute()
        self.assertFalse(result)
        
    
    def test_condition3(self):
        
        usm_fiat=UserGrowth_Spaced(100,54000,100,log_saturated_space)
        ap_fiat=AgentPool_Basic(users_controller=usm_fiat,transactions_controller=100,currency='$')
        for i in range(15):
            ap_fiat.execute()
        
        result=Condition(sim_component=ap_fiat,variables=['transactions','num_users'],condition=lambda x:x[0]>10000 and x[1]>20000).execute()
        self.assertTrue(result)
        
        
        
        
    def test_full_meta_simulation(self):
        ITERATIONS=72
        HOLDING_TIME=1
        SUPPLY=0.17*10**9

        #Primary
        usm_luxury=UserGrowth_Spaced(10,54,ITERATIONS,log_saturated_space,name='usm luxury')
        tsm_luxury=TransactionManagement_Stochastic(activity_probs=np.linspace(0.25,0.1,ITERATIONS),
                                                    value_dist_parameters={'loc':10000,'scale':10000/7},
                                                   transactions_dist_parameters={'mu':1},name='trans luxury')

        ap_luxury=AgentPool_Basic(users_controller=usm_luxury,transactions_controller=tsm_luxury,
                                                  currency='$',name='prime pool')



        #Secondary
        #make the sequence of parameters
        loc_param=generate_distribution_param_from_sequence('loc',np.linspace,500,750,ITERATIONS)
        scale_param=generate_distribution_param_from_sequence('scale',np.linspace,500/7,750/7,ITERATIONS)
        value_dist_params=merge_param_dists(loc_param,scale_param)


        usm_luxury_sec=UserGrowth_Spaced(10000,327800 ,ITERATIONS,log_saturated_space,name='secondary usm')
        tsm_luxury_sec=TransactionManagement_Stochastic(activity_probs=np.linspace(0.25,0.1,ITERATIONS),
                                                    value_dist_parameters=value_dist_params,
                                                   transactions_dist_parameters={'mu':26/12},name='secondary trans')

        ap_luxury_sec=AgentPool_Basic(users_controller=usm_luxury_sec,transactions_controller=tsm_luxury_sec, currency='$',name='secondary pool')


        #Primary
        loc_param=generate_distribution_param_from_sequence('loc',np.linspace,200000,500000,ITERATIONS)
        scale_param=generate_distribution_param_from_sequence('scale',np.linspace,200000/7,500000/7,ITERATIONS)
        value_dist_params=merge_param_dists(loc_param,scale_param)

        usm_fine=UserGrowth_Spaced(5,27,ITERATIONS,log_saturated_space)
        tsm_fine=TransactionManagement_Stochastic(activity_probs=np.linspace(0.75,0.25,ITERATIONS),
                                                  value_dist_parameters=value_dist_params,
                                                   transactions_dist_parameters={'mu':1})

        ap_fine=AgentPool_Basic(users_controller=usm_fine,transactions_controller=tsm_fine,currency='$')

        #Secondary
        loc_param=generate_distribution_param_from_sequence('loc',np.linspace,500,1000,ITERATIONS)
        scale_param=generate_distribution_param_from_sequence('scale',np.linspace,500/7,1000/7,ITERATIONS)
        value_dist_params=merge_param_dists(loc_param,scale_param)

        usm_fine_sec=UserGrowth_Spaced(10000,327800,ITERATIONS,log_saturated_space)
        tsm_fine_sec=TransactionManagement_Stochastic(activity_probs=np.linspace(0.25,0.10,ITERATIONS),
                                                  value_dist_parameters=value_dist_params,
                                                   transactions_dist_parameters={'mu':26/12})

        ap_fine_sec=AgentPool_Basic(users_controller=usm_fine_sec,transactions_controller=tsm_fine_sec,currency='$')

        #Primary
        tsm_own=TransactionManagement_Stochastic(value_per_transaction=10000,
                                                   transactions_dist_parameters={'mu':52/12})

                                                  
        ap_own=AgentPool_Basic(users_controller=1,transactions_controller=tsm_own,currency='$')




        te=TokenEconomy_Basic(holding_time=HOLDING_TIME,supply=SUPPLY,initial_price=0.1)
        te.add_agent_pools([ap_luxury,ap_luxury_sec,ap_fine,ap_fine_sec,ap_own])
        prices=[]

            
        meta=TokenMetaSimulator(te)
        meta.execute(iterations=ITERATIONS,repetitions=10)
        reps=meta.get_data()

        plot,data=meta.get_timeseries('token_price')
        print(reps.shape)
        self.assertTrue(reps.shape[0]==720)
        
    


if __name__ == '__main__':
    unittest.main()