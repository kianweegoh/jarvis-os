import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './routes/Dashboard'
import GraphView from './routes/GraphView'
import NoteView from './routes/NoteView'

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/graph" element={<GraphView />} />
        <Route path="/note/:id" element={<NoteView />} />
      </Route>
    </Routes>
  )
}

export default App
