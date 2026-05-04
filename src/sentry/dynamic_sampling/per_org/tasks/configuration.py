from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum

from sentry import options, quotas
from sentry.constants import SAMPLING_MODE_DEFAULT, TARGET_SAMPLE_RATE_DEFAULT, ObjectStatus
from sentry.dynamic_sampling.types import DynamicSamplingMode, SamplingMeasure
from sentry.dynamic_sampling.utils import has_custom_dynamic_sampling
from sentry.models.options.project_option import ProjectOption
from sentry.models.organization import Organization
from sentry.models.project import Project


class DynamicSamplingVersion(StrEnum):
    DynamicSampling = "dynamic-sampling-am2"
    CustomDynamicSampling = "custom-dynamic-sampling-am3"


class DynamicSamplingOrgConfiguration:
    def __init__(self, organization: Organization) -> None:
        self.organization = organization
        self.measure = self._get_sampling_measure()
        self.version = self._get_version()
        self.mode = self._get_mode()
        self.sample_rate, self.project_sample_rates = self._get_sample_rates()

    def _get_version(self) -> DynamicSamplingVersion:
        if has_custom_dynamic_sampling(self.organization) or self.measure == SamplingMeasure.SPANS:
            return DynamicSamplingVersion.CustomDynamicSampling
        return DynamicSamplingVersion.DynamicSampling

    def _get_mode(self) -> DynamicSamplingMode:
        if not has_custom_dynamic_sampling(self.organization):
            return DynamicSamplingMode.ORGANIZATION
        return self.organization.get_option("sentry:sampling_mode", SAMPLING_MODE_DEFAULT)

    def _get_sampling_measure(self) -> SamplingMeasure:
        if has_custom_dynamic_sampling(self.organization):
            return SamplingMeasure.SPANS
        if options.get("dynamic-sampling.check_span_feature_flag") and self.organization.id in (
            options.get("dynamic-sampling.measure.spans") or []
        ):
            return SamplingMeasure.SPANS
        return SamplingMeasure.SEGMENTS

    def _get_sample_rates(self) -> tuple[float | None, Mapping[int, float | None]]:
        if self.version == DynamicSamplingVersion.DynamicSampling:
            return quotas.backend.get_blended_sample_rate(organization_id=self.organization.id), {}

        if self.mode == DynamicSamplingMode.PROJECT:
            return self._get_project_mode_sample_rates()

        if has_custom_dynamic_sampling(self.organization):
            return (
                float(
                    self.organization.get_option(
                        "sentry:target_sample_rate", TARGET_SAMPLE_RATE_DEFAULT
                    )
                ),
                {},
            )

        return quotas.backend.get_blended_sample_rate(organization_id=self.organization.id), {}

    def _get_project_mode_sample_rates(self) -> tuple[float | None, Mapping[int, float | None]]:
        project_ids = list(
            Project.objects.filter(
                organization_id=self.organization.id, status=ObjectStatus.ACTIVE
            ).values_list("id", flat=True)
        )
        if not project_ids:
            return None, {}

        project_sample_rates = ProjectOption.objects.get_value_bulk_id(
            project_ids, "sentry:target_sample_rate"
        )
        sample_rates = {
            project_id: (
                float(project_sample_rates[project_id])
                if project_sample_rates[project_id] is not None
                else None
            )
            for project_id in project_ids
        }
        for sample_rate in sample_rates.values():
            if sample_rate is not None:
                return sample_rate, sample_rates

        return None, sample_rates

    @property
    def is_enabled(self) -> bool:
        return self.sample_rate is not None

    @property
    def is_classic_dynamic_sampling(self) -> bool:
        return self.version == DynamicSamplingVersion.DynamicSampling

    @property
    def is_custom_dynamic_sampling(self) -> bool:
        return self.version == DynamicSamplingVersion.CustomDynamicSampling

    @property
    def is_project_mode(self) -> bool:
        return self.mode == DynamicSamplingMode.PROJECT

    @property
    def is_organization_mode(self) -> bool:
        return self.mode == DynamicSamplingMode.ORGANIZATION

    @property
    def is_am3_project_mode(self) -> bool:
        return self.is_custom_dynamic_sampling and self.is_project_mode

    @property
    def is_am3_organization_mode(self) -> bool:
        return self.is_custom_dynamic_sampling and self.is_organization_mode

    @property
    def is_span_based(self) -> bool:
        return self.measure == SamplingMeasure.SPANS

    @property
    def is_segment_based(self) -> bool:
        return self.measure == SamplingMeasure.SEGMENTS
