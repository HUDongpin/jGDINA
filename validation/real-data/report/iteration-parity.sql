WITH report_rows ("case", "runtime", "iterations") AS (
VALUES
  ('ecpe-gdina', 'R', 1639),
  ('ecpe-gdina', 'jGDINA', 1639),
  ('ecpe-dino', 'R', 653),
  ('ecpe-dino', 'jGDINA', 653),
  ('tatsuoka1990-dina', 'R', 1170),
  ('tatsuoka1990-dina', 'jGDINA', 1170),
  ('ecpe-gdina-missing', 'R', 764),
  ('ecpe-gdina-missing', 'jGDINA', 764)
)
SELECT * FROM report_rows ORDER BY "case";
