import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout.js';
import { HeatingPage } from './pages/Heating.js';
import { NotYetPage } from './pages/NotYet.js';
import { OverviewPage } from './pages/Overview.js';
import { RoomsPage } from './pages/Rooms.js';
import { SystemPage } from './pages/System.js';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/rooms', element: <RoomsPage /> },
      {
        path: '/energy',
        element: <NotYetPage title="Energy" sourceIds={['smart_meters']} milestone="M7" />,
      },
      { path: '/heating', element: <HeatingPage /> },
      {
        path: '/water',
        element: <NotYetPage title="Water" sourceIds={['thames_water']} milestone="M8" />,
      },
      {
        path: '/wifi',
        element: <NotYetPage title="Wi-Fi" sourceIds={['wifi', 'speed_test']} milestone="M9" />,
      },
      { path: '/system', element: <SystemPage /> },
      { path: '*', element: <OverviewPage /> },
    ],
  },
]);
