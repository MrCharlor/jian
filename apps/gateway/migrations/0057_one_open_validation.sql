CREATE UNIQUE INDEX validations_one_open ON validations (epic_work_id) WHERE state = 'aberta';
