import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './smarter-than-5th-grader.css'
import SmarterThan5thGraderApp from './SmarterThan5thGraderApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SmarterThan5thGraderApp />
  </StrictMode>,
)
