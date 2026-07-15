-- 演示用样例线索（仅本地测试；正式数据用 CSV 导入）
INSERT INTO leads (company_name, website, email, country, source, keyword, status) VALUES
  ('Acme Starlink Installs', 'https://acmestarlink.example', 'sales@acmestarlink.example', 'US', 'seed', 'Starlink installer', 'new'),
  ('Nomad RV Upfitters',     'https://nomadrv.example',      'hello@nomadrv.example',      'US', 'seed', 'RV Starlink mount', 'new'),
  ('BlueWater Marine Comms', 'https://bluewatercomms.example','info@bluewatercomms.example','AU', 'seed', 'Marine Starlink installation', 'new'),
  ('OutbackNet Solutions',   'https://outbacknet.example',   'contact@outbacknet.example', 'AU', 'seed', 'Off-grid solar installer', 'new'),
  ('Remote Ridge ISP',       'https://remoteridge.example',  '',                          'CA', 'seed', 'Remote internet provider', 'new');
