import { createBrowserRouter } from 'react-router';
import { Layout } from './components/Layout.js';
import { EnergyPage } from './pages/Energy.js';
import { HeatingPage } from './pages/Heating.js';
import { OverviewPage } from './pages/Overview.js';
import { RoomsPage } from './pages/Rooms.js';
import { SystemPage } from './pages/System.js';
import { WaterPage } from './pages/Water.js';
import { WeatherPage } from './pages/Weather.js';
import { WifiPage } from './pages/Wifi.js';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/rooms', element: <RoomsPage /> },
      { path: '/weather', element: <WeatherPage /> },
      { path: '/energy', element: <EnergyPage /> },
      { path: '/heating', element: <HeatingPage /> },
      { path: '/water', element: <WaterPage /> },
      { path: '/wifi', element: <WifiPage /> },
      { path: '/system', element: <SystemPage /> },
      { path: '*', element: <OverviewPage /> },
    ],
  },
]);
