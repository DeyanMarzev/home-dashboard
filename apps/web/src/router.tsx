import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout.js';
import { EnergyPage } from './pages/Energy.js';
import { HeatingPage } from './pages/Heating.js';
import { NotYetPage } from './pages/NotYet.js';
import { OverviewPage } from './pages/Overview.js';
import { RoomsPage } from './pages/Rooms.js';
import { SystemPage } from './pages/System.js';
import { WaterPage } from './pages/Water.js';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/rooms', element: <RoomsPage /> },
      { path: '/energy', element: <EnergyPage /> },
      { path: '/heating', element: <HeatingPage /> },
      { path: '/water', element: <WaterPage /> },
      {
        path: '/wifi',
        element: <NotYetPage title="Wi-Fi" sourceIds={['wifi', 'speed_test']} milestone="M9" />,
      },
      { path: '/system', element: <SystemPage /> },
      { path: '*', element: <OverviewPage /> },
    ],
  },
]);
