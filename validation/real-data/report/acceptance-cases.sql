WITH report_rows ("case", "dataset", "model", "dimensions", "missing", "iterations", "log_likelihood_difference", "item_probability_difference", "prior_probability_difference", "eap_probability_difference", "map_agreement", "mle_agreement", "eap_agreement", "class_agreement", "result") AS (
VALUES
  ('ecpe-gdina', 'ECPE', 'GDINA', '2922 × 28 × 3', 0, '1639 / 1639', '1.455e-11', '6.661e-14', '1.205e-14', '1.144e-13', '100.00%', '100.00%', '100.00%', '100.00% / 100.00% / 100.00%', 'PASS'),
  ('ecpe-dino', 'ECPE', 'DINO', '2922 × 28 × 3', 0, '653 / 653', '0.000e+0', '5.884e-15', '1.010e-14', '3.991e-14', '100.00%', '100.00%', '100.00%', '100.00% / 100.00% / 100.00%', 'PASS'),
  ('tatsuoka1990-dina', 'Tatsuoka1990', 'DINA', '536 × 20 × 8', 0, '1170 / 1170', '9.095e-12', '1.101e-13', '1.887e-15', '4.836e-13', '100.00%', '100.00%', '100.00%', '100.00% / 100.00% / 100.00%', 'PASS'),
  ('ecpe-gdina-missing', 'ECPE', 'GDINA', '2922 × 28 × 3', 812, '764 / 764', '2.183e-11', '7.772e-15', '1.998e-15', '3.086e-14', '100.00%', '100.00%', '100.00%', '100.00% / 100.00% / 100.00%', 'PASS')
)
SELECT * FROM report_rows ORDER BY "case";
