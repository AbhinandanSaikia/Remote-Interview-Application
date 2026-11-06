import React from 'react'
import { Toaster } from 'react-hot-toast'
import { Navigate, Route, Routes } from 'react-router-dom'
import Login from './pages/Login'
import ProtectedRoute from './components/ProtectedRoute'
import Protectedlayout from './components/Protectedlayout'
import Dashboard from './pages/Dashboard'
import Sessions from './pages/Sessions'
import Pricing from './pages/Pricing'
import MeetingRoom from './pages/MeetingRoom'

const App = () => {
  return (
    <>
      <Toaster />
      <Routes>
        {/* Public Routes */}
        <Route path='/login' element={ <Login mode="login"/>}/>
        <Route path='/register' element={ <Login mode="register"/>}/>

        {/* Private Routes */}
        <Route element={<ProtectedRoute />}>
          <Route element={<Protectedlayout />}>
            <Route path='/dashboard' element={ <Dashboard /> }/>
            <Route path='/sessions' element={ <Sessions /> }/>
            <Route path='/pricing' element={ <Pricing /> }/>
          </Route>
          <Route path='/meeting/:meetingId' element={ <MeetingRoom /> }/>
        </Route>

        {/* other Routes */}
      <Route path='*' element={ <Navigate to='/dashboard' replace/> }/>
      </Routes>
    </>
  )
}

export default App