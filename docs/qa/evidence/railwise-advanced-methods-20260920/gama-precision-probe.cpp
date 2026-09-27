// Evidence-only adapter to the unmodified GNU Gama 2.29 library, not a solver.
#include <fstream>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <gnu_gama/version.h>
#include <gnu_gama/xml/gkfparser.h>
#include <gnu_gama/local/acord/acord2.h>
#include <gnu_gama/local/language.h>
#include <gnu_gama/local/network.h>
#include <gnu_gama/local/results/text/general_parameters.h>
#include <gnu_gama/local/test_linearization_visitor.h>

int main(int argc, char** argv) {
  using namespace GNU_gama::local;
  try {
    if (argc != 3 || (std::string(argv[2]) != "svd" && std::string(argv[2]) != "gso"))
      throw std::runtime_error("usage: gama-precision-probe input.xml svd|gso");
    std::ifstream input(argv[1]);
    if (!input) throw std::runtime_error("input unavailable");
    const std::string xml((std::istreambuf_iterator<char>(input)), {});
    set_gama_language(en);
    LocalNetwork network;
    GKFparser parser(network);
    parser.xml_parse(xml.c_str(), static_cast<int>(xml.size()), 1);
    network.set_algorithm(argv[2]);
    network.set_max_linearization_iterations(0);
    network.remove_inconsistency();
    Acord2 approximate(network.PD, network.OD);
    approximate.execute();
    refine_obsdh_reductions(&network);
    if (network.huge_abs_terms() || !network.connected_network())
      throw std::runtime_error("fixture has rejected observations or disconnected components");
    std::ostringstream diagnostic;
    if (!GeneralParameters(&network, diagnostic))
      throw std::runtime_error(diagnostic.str());
    network.refine_adjustment();
    if (!network.m_0_apriori() || network.apriori_m_0() != 1)
      throw std::runtime_error("fixture must use explicit unit a-priori scale");
    const auto& corrections = network.solve();
    const auto& residuals = network.residuals();
    std::vector<int> indexes;
    std::cout << std::setprecision(17)
      << "{\"version\":\"" << GNU_gama::GNU_gama_version()
      << "\",\"algorithm\":\"" << network.algorithm()
      << "\",\"degreesOfFreedom\":" << network.degrees_of_freedom()
      << ",\"defect\":" << network.null_space()
      << ",\"unknownCount\":" << network.unknowns_count()
      << ",\"observationCount\":" << network.observations_count()
      << ",\"weightedSSE\":" << network.trans_VWV()
      << ",\"aprioriScale\":" << network.apriori_m_0()
      << ",\"points\":[";
    bool separator = false;
    for (const auto& entry : network.PD) {
      const auto& point = entry.second;
      if (!point.active_z() || point.index_z() == 0) continue;
      if (separator) std::cout << ',';
      separator = true;
      indexes.push_back(point.index_z());
      std::cout << "{\"id\":\"" << entry.first.str()
        << "\",\"heightM\":" << point.z() + corrections(point.index_z()) / 1000
        << ",\"correctionM\":" << corrections(point.index_z()) / 1000 << '}';
    }
    std::cout << "],\"observations\":[";
    for (int i = 1; i <= network.observations_count(); ++i) {
      if (i > 1) std::cout << ',';
      const auto* observation = network.ptr_obs(i);
      std::cout << "{\"from\":\"" << observation->from().str()
        << "\",\"to\":\"" << observation->to().str()
        << "\",\"observedM\":" << observation->value()
        << ",\"gamaCorrectionM\":" << residuals(i) / 1000
        << ",\"residualObservedMinusAdjustedM\":" << -residuals(i) / 1000 << '}';
    }
    // Gama's corrections are mm; with sigma-apr=1, qxx is converted by 10^-6.
    std::cout << "],\"heightCofactorM2\":[";
    for (size_t i = 0; i < indexes.size(); ++i) {
      if (i) std::cout << ',';
      std::cout << '[';
      for (size_t j = 0; j < indexes.size(); ++j) {
        if (j) std::cout << ',';
        std::cout << network.qxx(indexes[i], indexes[j]) / 1000000;
      }
      std::cout << ']';
    }
    std::cout << "],\"residualCofactorM2\":[";
    for (int i = 1; i <= network.observations_count(); ++i) {
      if (i > 1) std::cout << ',';
      std::cout << '[';
      for (int j = 1; j <= network.observations_count(); ++j) {
        if (j > 1) std::cout << ',';
        // qbb is in whitened observation coordinates, unlike qxx.
        const double projectionResidual = (i == j ? 1 : 0) - network.qbb(i, j);
        std::cout << projectionResidual
          / std::sqrt(network.weight_obs(i) * network.weight_obs(j)) / 1000000;
      }
      std::cout << ']';
    }
    std::cout << "]}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  } catch (...) {
    std::cerr << "GNU Gama rejected the fixture\n";
    return 2;
  }
}
