
package com.irisvocal.irisvocal_backend.Service;

import com.irisvocal.irisvocal_backend.Dto.LoginRequest;
import com.irisvocal.irisvocal_backend.Dto.RegisterRequest;
import com.irisvocal.irisvocal_backend.Model.User;
import com.irisvocal.irisvocal_backend.Repository.UserRepository;

import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class UserService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
//passwordEncoder is an interface and BCryptPasswordEncoder is class that implements it
    public UserService(UserRepository userRepository,PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder =passwordEncoder;
    }

    public void registerUser(RegisterRequest request) {

        if (userRepository.existsByEmail(request.getEmail())) {
            throw new IllegalArgumentException(
                    "Email is already registered"
            );
        }

        User user = User.builder()
                .name(request.getName())
                .email(request.getEmail())
                .passwordHash(
                        passwordEncoder.encode(request.getPassword())
                )
                .emergencyContactName(request.getEmergencyContactName())
                .emergencyContactNumber(request.getEmergencyContactNumber())
                .emergencyContactEmail(request.getEmergencyContactEmail())
                .build();

        userRepository.save(user);
    }
    public User loginUser(LoginRequest request){
        User user=userRepository.findByEmail(request.getEmail()).orElseThrow(()-> new IllegalArgumentException("Invalid email or password"));
        boolean passwordMatches= passwordEncoder.matches(request.getPassword(), user.getPasswordHash());
        if (!passwordMatches) {
            throw new IllegalArgumentException("Invalid email or password");
        }
        return user;
    }
    public User findUserByEmail(String email) {
        return userRepository.findByEmail(email)
                .orElseThrow(() ->
                        new IllegalArgumentException("User not found"));
    }
}
