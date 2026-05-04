from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from sentry.dynamic_sampling.per_org.tasks.queries import (
    get_eap_organization_volume,
    get_eap_project_volumes,
)
from sentry.dynamic_sampling.tasks.common import OrganizationDataVolume
from sentry.dynamic_sampling.types import SamplingMeasure
from sentry.testutils.cases import TestCase


class EAPOrganizationVolumeTest(TestCase):
    def test_get_eap_organization_volume_existing_org(self) -> None:
        organization = self.create_organization()
        project = self.create_project(organization=organization)
        other_organization = self.create_organization()
        self.create_project(organization=other_organization)

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query",
            return_value={"data": [{"count()": 2, "count_sample()": 2}]},
        ) as run_table_query:
            org_volume = get_eap_organization_volume(organization, time_interval=timedelta(hours=1))

        assert org_volume == OrganizationDataVolume(org_id=organization.id, total=2, indexed=2)
        run_table_query.assert_called_once()
        assert run_table_query.call_args.kwargs["params"].organization == organization
        assert run_table_query.call_args.kwargs["params"].projects == [project]
        assert run_table_query.call_args.kwargs["query_string"] == "is_transaction:true"

    def test_get_eap_organization_volume_returns_raw_and_extrapolated_counts(self) -> None:
        organization = self.create_organization()
        self.create_project(organization=organization)

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query",
            return_value={"data": [{"count()": 10, "count_sample()": 1}]},
        ):
            org_volume = get_eap_organization_volume(organization, time_interval=timedelta(hours=1))

        assert org_volume == OrganizationDataVolume(org_id=organization.id, total=10, indexed=1)

    def test_get_eap_organization_volume_with_spans_measure(self) -> None:
        organization = self.create_organization()
        self.create_project(organization=organization)

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query",
            return_value={"data": [{"count()": 2, "count_sample()": 2}]},
        ) as run_table_query:
            org_volume = get_eap_organization_volume(
                organization, time_interval=timedelta(hours=1), measure=SamplingMeasure.SPANS
            )

        assert org_volume == OrganizationDataVolume(org_id=organization.id, total=2, indexed=2)
        run_table_query.assert_called_once()
        assert run_table_query.call_args.kwargs["query_string"] == ""

    def test_get_eap_organization_volume_without_traffic(self) -> None:
        organization = self.create_organization()
        self.create_project(organization=organization)

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query",
            return_value={"data": [{"count()": 0, "count_sample()": 0}]},
        ):
            org_volume = get_eap_organization_volume(organization, time_interval=timedelta(hours=1))

        assert org_volume is None

    def test_get_eap_organization_volume_without_projects(self) -> None:
        organization = self.create_organization()

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query"
        ) as run_table_query:
            org_volume = get_eap_organization_volume(organization, time_interval=timedelta(hours=1))

        assert org_volume is None
        run_table_query.assert_not_called()

    def test_get_eap_project_volumes_existing_org(self) -> None:
        organization = self.create_organization()
        project = self.create_project(organization=organization)
        other_project = self.create_project(organization=organization)
        other_organization = self.create_organization()
        self.create_project(organization=other_organization)

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query",
            return_value={
                "data": [
                    {"project.id": project.id, "count()": 2, "count_sample()": 2},
                    {"project.id": other_project.id, "count()": 1, "count_sample()": 1},
                ]
            },
        ) as run_table_query:
            project_volumes = get_eap_project_volumes(
                organization, time_interval=timedelta(hours=1)
            )

        assert sorted(project_volumes) == [
            (project.id, 2, 2, 0),
            (other_project.id, 1, 1, 0),
        ]
        run_table_query.assert_called_once()
        assert sorted(run_table_query.call_args.kwargs["params"].projects, key=lambda p: p.id) == [
            project,
            other_project,
        ]
        assert run_table_query.call_args.kwargs["query_string"] == "is_transaction:true"

    def test_get_eap_project_volumes_without_traffic(self) -> None:
        organization = self.create_organization()
        self.create_project(organization=organization)

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query",
            return_value={"data": []},
        ):
            project_volumes = get_eap_project_volumes(
                organization, time_interval=timedelta(hours=1)
            )

        assert project_volumes == []

    def test_get_eap_project_volumes_without_projects(self) -> None:
        organization = self.create_organization()

        with patch(
            "sentry.dynamic_sampling.per_org.tasks.queries.Spans.run_table_query"
        ) as run_table_query:
            project_volumes = get_eap_project_volumes(
                organization, time_interval=timedelta(hours=1)
            )

        assert project_volumes == []
        run_table_query.assert_not_called()
